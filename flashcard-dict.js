/* 听写引擎（三、四、五年级闪卡页共用一份）
   ------------------------------------------------------------------
   study-site/flashcard-dict.js —— 卡片内作答、5 次机会、短语按单词分格、
   生词本循环听写、本组题量 15 / 30 / 50，全在这里。

   页面怎么用（三页文本一致）：
     <script src="flashcard-dict.js"></script>
     const Dict = window.FlashcardDict.create({ ...本页依赖... });
     const {startDict, submitDict, ...} = Dict;   // 名字与搬走前一致，调用点不用改
     Dict.bind();

   页面只留自己的东西：
     · 会话存档 D —— 变量留在页面（测试与外部代码直接读它），core 通过
       getState/setState 读写；
     · 语音开关（speakOn / setSpeakOn / updateMuteBtn / autoSpeak）；
     · 各页文案、图标表 I、卡组表 BANKS。
   依赖 flashcard-core.js（normSpell / spoken / dictTokens / lw），必须先加载。
   ------------------------------------------------------------------ */
(function(){
  'use strict';
  const FC = window.FlashcardCore;
  if (!FC) throw new Error('flashcard-dict.js 需要先加载 flashcard-core.js');
  const { lw, spoken, normSpell, dictTokens } = FC;

  function create(env) {
    /* 稳定引用：页面里的函数声明与常量表不会换人 */
    const $ = env.$, esc = env.esc, I = env.I;
    const favWords = env.favWords, scopeWords = env.scopeWords, shuffle = env.shuffle;
    const toast = env.toast, closeModal = env.closeModal, openModal = env.openModal;
    const setMastered = env.setMastered, hitsOf = env.hitsOf, leaveBook = env.leaveBook;
    const favKey = env.favKey, save = env.save, renderProgress = env.renderProgress;
    const syncWordDeck = env.syncWordDeck, isSentBank = env.isSentBank, showCard = env.showCard;
    const renderWordLine = env.renderWordLine, renderMeta = env.renderMeta;
    const renderHeart = env.renderHeart, updateChrome = env.updateChrome;
    const wordLink = env.wordLink, speak = env.speak, speakCurrent = env.speakCurrent;
    const autoSpeak = env.autoSpeak;
    /* 会话存档：D 由页面持有（换页/换卡组会重赋值），每次现取 */
    const getD = env.getState, setD = env.setState;

const DICT_SIZES=[15,30,50];
const DICT_MAX_TRY=5;            // 听写最多试 5 次：到第 5 次才摊开答案（与句子练习同口径）
let DICT_SIZE=15;
function dictActive(){ const D = getD(); return !!(D && document.body.classList.contains('dict-mode')); }
/* 重听当前题：听写模式读正在考的词，卡片界面读当前这一面 */
function speakPrompt(){
  const D = getD();
  if(dictActive()&&D&&D.list[D.i]){ speak(spoken(D.list[D.i].w),'word'); return; }
  speakCurrent();
}
/* ---------- 本组题量 15 / 30 / 50 ---------- */
function dictSizeKey(){ return 'pep3s_dict_size|'+env.P.active; }
function dictReadSize(){
  try{ const n=Number(localStorage.getItem(dictSizeKey())); if(DICT_SIZES.indexOf(n)>=0) DICT_SIZE=n; }catch(e){}
}
function dictSaveSize(){ try{ localStorage.setItem(dictSizeKey(),String(DICT_SIZE)); }catch(e){} }
function dictSizePopSet(open){
  const wrap=$('dictSize'), pop=$('dictSizePop'), btn=$('dictSizeBtn');
  if(!wrap||!pop||!btn) return;
  pop.hidden=!open; wrap.classList.toggle('open',!!open);
  btn.setAttribute('aria-expanded',open?'true':'false');
}
function syncDictSize(){
  const lb=$('dictSizeLabel'); if(lb) lb.textContent=DICT_SIZE+' 题';
  const pop=$('dictSizePop'); if(pop) pop.querySelectorAll('[data-dsize]').forEach(b=>{
    const on=Number(b.dataset.dsize)===DICT_SIZE;
    b.classList.toggle('on',on); b.setAttribute('aria-selected',on?'true':'false');
  });
}
/* ---------- 开始听写：不再弹窗，直接在卡片里作答 ---------- */
function startDict(mode){
  // 'unit'：当前范围抽 N 题（默认 15）；'loop'（兼容旧名 'book'）：生词本全部打乱反复听写
  const loop = mode==='loop' || mode==='book';
  const pool = loop ? favWords() : scopeWords();
  if(!pool.length){ toast(loop?'生词本里还没有词':'当前范围没有可听写的词'); return; }
  if(!loop) dictReadSize();
  const list = loop ? shuffle(pool) : shuffle(pool).slice(0,Math.min(DICT_SIZE,pool.length));
  const D={mode:loop?'loop':'unit',list:list,i:0,qno:1,total:pool.length,right:0,fixed:0,wrong:[],
     missed:new Set(),answered:false,lastOk:false,typed:'',parts:null,partOk:null,feedback:'',
     tries:0,hint:false};
  setD(D);
  closeModal();
  document.body.classList.add('dict-mode');
  const dt=$('dictTools'); if(dt) dt.hidden=loop;
  syncDictSize();
  renderDictCard(); syncDictChrome();
  autoSpeak(spoken(list[0].w),'word');
}
/* 短语听写按单词个数分格：「/」前后是同一短语的两种说法，只考斜杠前的主说法；
   纯标点（/ ? ! -）不单独占格。单词与单词式短语返回单元素数组（仍然是一整条下划线）。 */
/* dictTokens 来自 flashcard-core.js：短语按单词分格（… 当空格、/ 只取前半） */
/* 摊开答案的提示卡：第 5 次猜完才出现，之后必须改对才能进下一题 */
function dictAnswerHtml(w){
  const ipa=w.ipa?`<span class="dipa">/${esc(w.ipa)}/</span>`:'';
  return `<div class="dict-fb bad">正确答案是 <span class="spell">${esc(w.w)}</span>${ipa}`+
    `<div class="dtyped">照着答案把每一格改对，就能进下一题</div></div>`;
}
/* 听写格之间移动光标（越界不动） */
function dictFocus(inputs,n){
  const t=inputs&&inputs[n];
  if(t){ try{ t.focus(); }catch(e){} }
}
// 只就地换提示条，不重建输入框 —— 连按回车时光标不会被重置回第一格
function dictPatchFeedback(){
  const D = getD();
  const slot=$('dictSlot'); if(!slot) return;
  const host=slot.parentElement||slot;
  const old=host.querySelector('.dict-fb');
  if(old) old.remove();
  if(D&&D.feedback) slot.insertAdjacentHTML('afterend', D.feedback);
}
function renderDictCard(){
  const D = getD();
  if(!D) return;
  const w=D.list[D.i];
  if(!w){ dictDone(); return; }
  const loop=D.mode==='loop', total=D.list.length, no=loop?D.qno:(D.i+1);
  const toks=dictTokens(w), multi=toks.length>1;
  $('meta').innerHTML=`<span class="badge">${esc(env.UNITS[w.unit-1].label)}</span>`+
    `<span class="badge times">第 ${no} / ${total} 题</span>`;
  const sub = loop
    ? `生词本里的词打乱顺序反复练 · 写对 ${env.HIT_GOAL} 次自动移出（还剩 ${Object.keys(env.B.fav).length} 个）`
    : (multi?'听短语，一个词填一格，填好按回车（英式发音，稍慢）'
            :'听'+env.BANK.item+'，把英文拼写出来（英式发音，稍慢）');
  const el=$('wordLine');
  el.className='word-line dict-line';
  el.style.cssText='';
  const slots = multi
    ? toks.map((t,i)=>{
        // 每格宽度按这个词的字母数给，长短词一眼能看出对应关系（连字符词不拆格）
        const n=Math.max(2,Math.min(11,t.replace(/[^A-Za-z0-9']/g,'').length));
        return `<input class="dict-w" data-k="${i}" data-need="${t.replace(/[^A-Za-z0-9']/g,'').length}" `+
          `style="width:calc(${n}ch + 20px)" type="text" `+
          `autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" aria-label="第 ${i+1} 个词">`;
      }).join('')
    : `<input id="dictInput" data-need="${toks[0].replace(/[^A-Za-z0-9']/g,'').length}" type="text" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="在这里拼写" aria-label="拼写${esc(env.BANK.item)}">`;
  // ok = 一次写对；hint = 已经摊开答案、还没改对；bad 不再单独用（逐格标色）
  const st = D.answered ? ' ok' : (D.hint?' hint':'');
  el.innerHTML=`<div class="dict-cn">${esc(w.cn)}</div>`+
    `<div class="dict-slot${multi?' multi':''}${st}" id="dictSlot">`+
    slots+`</div>`+
    (D.feedback||'')+
    ((D.answered||D.hint)?'':`<div class="dict-sub">${sub}</div>`);
  $('ipa').style.display='none'; $('segLine').style.display='none';
  const inputs=[...document.querySelectorAll('#dictSlot input')];
  inputs.forEach((inp,i)=>{
    if(D.parts) inp.value=D.parts[i]!=null?D.parts[i]:'';
    if(D.answered){ inp.disabled=true; }
    // 摊开答案后逐个标色：对的留绿、错的标红，孩子知道差在哪一格
    if(D.partOk) inp.classList.add(D.partOk[i]?'pt-ok':'pt-bad');
    if(!D.answered){
      inp.onkeydown=e=>{
        if(e.isComposing||e.keyCode===229) return;
        if(e.key===' '){
          e.stopPropagation();
          // 分格时空格是「跳下一格」，不再往横线上写空格
          if(multi){ e.preventDefault(); dictFocus(inputs,i+1); }
          return;
        }
        // 当前格空了再按退格：退回上一格并把光标放到末尾（与句子听写一致）
        if(e.key==='Backspace'&&!inp.value&&i>0){
          e.preventDefault(); e.stopPropagation();
          const p=inputs[i-1];
          try{ p.focus(); p.setSelectionRange(p.value.length,p.value.length); }catch(err){}
          return;
        }
        if(e.key==='Enter'||e.code==='NumpadEnter'){ e.preventDefault(); e.stopPropagation(); submitDict(); return; }
        e.stopPropagation();
      };
      inp.oninput=e=>{
        inp.classList.remove('pt-ok','pt-bad');
        if(e&&e.isComposing) return;
        // 写够这个词的字母数就自动跳到下一格（最后一格不跳）
        const need=Number(inp.dataset.need)||0;
        const got=inp.value.replace(/[^A-Za-z0-9']/g,'').length;
        if(multi && need && got>=need && i<inputs.length-1) dictFocus(inputs,i+1);
      };
    }
  });
  if(!D.answered){
    const bad=inputs.find(x=>x.classList.contains('pt-bad'));
    const target=bad||inputs.find(x=>!x.value.trim())||inputs[0];
    if(target) setTimeout(()=>{
      // 单格错到底时全选、直接重打；多格只定位，免得整格蓝底看着像另一条错误
      try{ target.focus(); if(bad&&inputs.length===1&&target.select) target.select(); }catch(e){}
    },80);
  }
}

function syncDictChrome(){
  const D = getD();
  if(!D) return;
  const badge=$('sentBadge');
  if(badge){
    badge.hidden=false;
    if(D.mode==='loop'){
      // 循环听写会一轮一轮重排，用「答对几题」比「第几题 / 总数」更好懂
      badge.innerHTML=`答对 <b>${D.right}</b><i> 题</i>`;
      badge.classList.remove('done');
    }else{
      const done=D.i+(D.answered?1:0), total=D.list.length;
      badge.innerHTML=`已做 <b>${done}</b><i>/${total}</i>`;
      badge.classList.toggle('done',done>=total&&total>0);
    }
  }
  const fh=$('frontHint');
  if(fh) fh.textContent='';
  const kb=document.querySelector('.front-hint .kbd-tip');
  if(kb) kb.innerHTML='　<kbd>Enter</kbd> 提交 / 下一题　<kbd>↑</kbd> 再听一次　<kbd>/</kbd> 朗读';
  const fb=$('btnFlip');
  if(fb){
    const txt = D.answered ? ((D.mode!=='loop' && D.i+1>=D.list.length)?'看结果':'下一题') : '提交答案';
    [...fb.childNodes].forEach(n=>{ if(n.nodeType===3&&n.textContent.trim()) n.textContent=txt; });
    fb.title=txt+'（快捷键 Enter）';
  }
  ['btnNext','btnBook','btnDictUnit','btnDict'].forEach(id=>{ const el=$(id); if(el) el.style.display='none'; });
  const heart=$('btnHeart'); if(heart) heart.style.display='none';
  ['btnDictReplay','btnDictExit'].forEach(id=>{ const el=$(id); if(el) el.hidden=false; });
}
function submitDict(){
  const D = getD();
  if(!D) return;
  if(D.answered){ dictNext(); return; }        // 已经拼对（或改对）→ 下一题
  const w=D.list[D.i];
  const toks=dictTokens(w);
  const inputs=[...document.querySelectorAll('#dictSlot input')];
  const multi=inputs.length>1;
  const parts=inputs.map(el=>el.value.trim());
  const empty=parts.filter(p=>!p).length;
  D.parts=parts;
  const shakeSlot=()=>{ const b=$('dictSlot'); if(b){ b.classList.remove('shake'); void b.offsetWidth; b.classList.add('shake'); } };

  // ⓪ 答案已经摊开了：不再计数、不再改写答案卡，只把光标送到空格；全填好了往下判题
  if(D.hint && empty){
    const nx=inputs.find(el=>!el.value.trim());
    if(nx){ try{ nx.focus(); }catch(e){} }
    return;
  }

  // ① 一个字都没写就回车：算交白卷，累计到第 5 次才给答案（防止误按回车）
  if(empty===parts.length){
    D.tries++;
    shakeSlot();
    if(D.tries>=DICT_MAX_TRY){
      D.hint=true;
      D.partOk=parts.map(()=>false);
      D.feedback=dictAnswerHtml(w);
    }else{
      D.feedback='<div class="dict-fb tip">先想一想怎么写 · 实在不会也照常回车</div>';
    }
    renderDictCard(); syncDictChrome();
    return;
  }
  // ② 还有格没填。已经写对其中几个词时，光标停着的若是一条空横线，
  //    回车算一次交白卷（累计 5 次照样给答案），否则永远卡在「只跳格」上弹不出答案。
  if(empty){
    const act=document.activeElement;
    const atEmpty = multi && inputs.indexOf(act)>=0 && !act.value.trim();
    if(atEmpty){
      D.tries++;
      shakeSlot();
      if(D.tries>=DICT_MAX_TRY){
        D.hint=true;
        // 已经写对的格留绿、空着的标红，孩子一眼看出还差哪几个词
        D.partOk=parts.map((p,i)=>!!p && normSpell(p)===normSpell(toks[i]||''));
        D.feedback=dictAnswerHtml(w);
        renderDictCard(); syncDictChrome();
        return;
      }
      D.feedback=`<div class="dict-fb tip">还有 ${empty} 个词没写 · 实在不会也照常回车</div>`;
      dictPatchFeedback();
      const nx=inputs.find(el=>!el.value.trim());
      if(nx && nx!==act){ try{ nx.focus(); }catch(e){} }
      return;
    }
    const nx=inputs.find(el=>!el.value.trim());
    if(nx){ try{ nx.focus(); }catch(e){} }
    return;
  }

  // ③ 判题
  const raw=parts.filter(Boolean).join(' ');
  D.typed=raw;
  D.partOk=parts.map((p,i)=>normSpell(p)===normSpell(toks[i]||''));
  const ok=normSpell(raw)===normSpell(toks.join(' ')) && D.partOk.every(Boolean);
  if(ok){
    // 三种「写对」要分开，别混着说：
    //   first    一次就写对 —— 才算「学会了」；
    //   byAnswer 摊开过答案才改对（D.hint 只在第 5 次才置真）—— 记成没写对；
    //   selfFixed 第 1~4 次写错后自己想起来改对 —— 同样记成没写对（第一次确实写错了），
    //             但不能说成「照着答案写的」，那会冤枉孩子。
    const byAnswer=!!D.hint;
    const first=(D.tries===0 && !byAnswer);
    D.answered=true; D.lastOk=first; D.hint=false;
    const k=favKey(w);
    const ipa=w.ipa?`<span class="dipa">/${esc(w.ipa)}/</span>`:'';
    if(first){
      D.right++;
      let extra='', removed=false;
      if(!D.missed.has(k)) setMastered(w,true);
      if(env.B.fav[k]){
        const n=hitsOf(w)+1;
        if(n>=env.HIT_GOAL){
          leaveBook(w); setMastered(w,true); removed=true;
          extra=`　写对 ${env.HIT_GOAL} 次，已移出生词本并计入「已记住」！`;
        }else{ env.B.hits[k]=n; extra=`　生词写对 ${n} / ${env.HIT_GOAL} 次`; }
      }
      if(!removed) extra+='　已计入「已记住」';
      save(); renderProgress();
      D.feedback=`<div class="dict-fb good">${I.check} 拼对了！<span class="spell">${esc(w.w)}</span>${ipa}${esc(extra)}</div>`;
    }else if(byAnswer){
      save(); renderProgress();
      D.feedback=`<div class="dict-fb tip">改对了，可以进下一题。这次是照着答案写的，下回自己再试试。</div>`;
    }else{
      // 自己发现写错又改对：**计入「已记住」**（家长 2026-11-25 定：能自己想起来就是记住了），
      // 但不算「一次答对」（D.right 不 +1，听写总结仍按一遍写对的题数算，便于家长看真实水平）。
      D.fixed++;
      setMastered(w,true);
      let extra='', removed=false;
      if(env.B.fav[k]){
        const n=hitsOf(w)+1;
        if(n>=env.HIT_GOAL){
          leaveBook(w); removed=true;
          extra=`　生词写对 ${env.HIT_GOAL} 次，已移出生词本。`;
        }else{ env.B.hits[k]=n; extra=`　生词写对 ${n} / ${env.HIT_GOAL} 次`; }
      }
      save(); renderProgress();
      D.feedback=`<div class="dict-fb good">${I.check} 改对了！<span class="spell">${esc(w.w)}</span>${ipa}${esc(extra)}`+
        `　已计入「已记住」，这是第 ${D.tries+1} 遍，下回争取一遍就写对。</div>`;
    }
    syncWordDeck(w);
    renderDictCard(); syncDictChrome();
    autoSpeak(spoken(w.w),'word');
    return;
  }

  // ④ 拼错：同样累计次数，第 5 次才摊开答案；在那之前只提示错了几处
  D.tries++;
  const badN=D.partOk.filter(x=>!x).length;
  shakeSlot();
  const k=favKey(w);
  if(!D.missed.has(k)){ D.missed.add(k); D.wrong.push(w); }
  setMastered(w,false);          // 写错就不再算「已记住」，重新回到闪卡卡组
  setFav(w,true);                // 听写写错自动收进生词列表
  save(); renderProgress();
  if(D.tries>=DICT_MAX_TRY){
    D.hint=true;
    D.feedback=dictAnswerHtml(w);
  }else{
    D.feedback=`<div class="dict-fb tip">有 ${badN} 个${multi?'词':'地方'}还不对，再看看中文提示</div>`;
  }
  renderDictCard(); syncDictChrome();
}

function dictNext(){
  const D = getD();
  if(!D) return;
  if(D.mode==='loop'){ loopNext(); return; }
  if(D.i+1<D.list.length){
    D.i++; D.answered=false; D.lastOk=false; D.typed=''; D.parts=null; D.partOk=null; D.feedback='';
    D.tries=0; D.hint=false;
    renderDictCard(); syncDictChrome(); autoSpeak(spoken(D.list[D.i].w),'word');
  }else dictDone();
}
// 循环听写：一轮走完后，把仍在生词本里的词重新打乱再来一轮，直到全部写对 2 次
function loopNext(){
  const D = getD();
  if(!D) return;
  if(!favWords().length){ dictDone(); return; }
  let w=null, guard=0;
  while(guard++<2000){
    D.i++;
    if(D.i>=D.list.length){
      const pool=favWords();
      if(!pool.length) break;
      D.list=shuffle(pool); D.i=0;
      toast('换一轮顺序，还有 '+pool.length+' 个生词要练');
    }
    const cand=D.list[D.i];
    if(cand && env.B.fav[favKey(cand)]){ w=cand; break; }
  }
  if(!w){ dictDone(); return; }
  D.qno++; D.answered=false; D.lastOk=false; D.typed=''; D.parts=null; D.partOk=null; D.feedback='';
  D.tries=0; D.hint=false;
  renderDictCard(); syncDictChrome(); autoSpeak(spoken(w.w),'word');
}
function dictDone(){
  const D = getD();
  if(!D) return;
  const wrong=[...new Map(D.wrong.map(w=>[lw(w.w),w])).values()];
  const left=Object.keys(env.B.fav).length, loop=D.mode==='loop';
  const den=loop?D.qno:D.list.length, right=D.right, fixed=D.fixed||0;
  const msg=loop
    ? (left?`这一轮一次拼对 ${right} 题${fixed?`、自己改对 ${fixed} 题`:''}，生词本还剩 ${left} 个词，随时可以再来一轮。`:`所有生词都写对 ${env.HIT_GOAL} 次了，太棒了！`)
    : (right===den?'全部一次拼对，太厉害了！'
        :(fixed?`一次拼对 ${right} 题，另有 ${fixed} 题自己改对了（已计入「已记住」），再练一遍就更稳了。`
               :'没一次拼对的词已经收进生词本，再练几次就记住了。'));
  const body=`<div class="dict-done"><div class="score">${right} / ${den}</div>
    <p style="color:var(--muted);font-size:14px">${msg}</p>
    ${wrong.length?`<div class="dict-wrong"><b>拼错的词</b><br>${wrong.map(w=>wordLink(w)).join('')}</div>`:''}</div>`;
  const foot=loop
    ? `<button class="btn" data-act="dict-loop" ${left?'':'disabled'}>继续听写生词</button><button class="btn" data-act="dict-unit">听写本单元</button><button class="btn primary" data-act="close">完成</button>`
    : `<button class="btn" data-act="dict-loop" ${left?'':'disabled'}>一键听写生词</button><button class="btn" data-act="dict-unit">再听写一次</button><button class="btn primary" data-act="close">完成</button>`;
  leaveDictMode();
  openModal(loop?(left?'本轮听写结束':'生词本清空啦'):'听写完成','继续保持，每天几个词就很棒',body,foot);
}
/* 退出听写模式：还原卡片与按钮，不影响已经记进档案的进度 */
function leaveDictMode(){
  const was=document.body.classList.contains('dict-mode');
  document.body.classList.remove('dict-mode');
  setD(null);
  const dt=$('dictTools'); if(dt) dt.hidden=true;
  dictSizePopSet(false);
  ['btnDictReplay','btnDictExit'].forEach(id=>{ const el=$(id); if(el) el.hidden=true; });
  const nb=$('btnNext'); if(nb) nb.style.display='';
  updateChrome();
  if(!was) return;
  if(isSentBank()||!env.cur){ showCard(); return; }
  renderWordLine(env.cur); renderMeta(env.cur); renderHeart(); renderProgress();
}

    /* ---------- 按钮与浮层绑定（页面调一次 Dict.bind()） ---------- */
    function bind() {
      $('btnDictReplay').onclick=()=>speakPrompt();
      $('btnDictExit').onclick=()=>leaveDictMode();
      $('dictSizeBtn').onclick=e=>{ e.stopPropagation(); dictSizePopSet($('dictSizePop').hidden); };
      $('dictSizePop').onclick=e=>{
        const b=e.target.closest('[data-dsize]'); if(!b) return;
        DICT_SIZE=Number(b.dataset.dsize)||15; dictSaveSize(); dictSizePopSet(false); syncDictSize();
        startDict('unit');
      };
      document.addEventListener('click',e=>{
        const pop=$('dictSizePop'); if(pop&&!pop.hidden&&!$('dictSize').contains(e.target)) dictSizePopSet(false);
      });
    }

    return {
      dictActive, dictSizeKey, dictReadSize, dictSaveSize, dictSizePopSet, syncDictSize,
      startDict, dictAnswerHtml, dictFocus, dictPatchFeedback, renderDictCard,
      syncDictChrome, submitDict, dictNext, loopNext, dictDone, leaveDictMode,
      speakPrompt, bind
    };
  }

  window.FlashcardDict = { create: create };
})();
