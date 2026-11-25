/* 句子引擎（三、四、五年级闪卡页共用一份）
   ------------------------------------------------------------------
   study-site/flashcard-sent.js —— 句子练习的听写 / 拼图两种练法、逐词槽位、
   回车跳格与 5 次机会、答完就地摊开成分着色 + 音标、本组 15/30/50、
   会话存档、错题集缓存与补传队列，全在这里。

   页面怎么用（三页文本一致）：
     <script src="flashcard-sent.js"></script>
     const Sent = window.FlashcardSent.create({ ...本页依赖... });
     const {sentSubmit, sentNext, ...} = Sent;   // 名字与搬走前一致，调用点不用改

   页面只留自己的东西：
     · 常量与状态（SENT_MAX_TRY / SENT_SIZES / 三个 localStorage 键 / ROLE_COLOR、
       SENT / PZ / SENT_WRONG）—— 变量留在页面，core 通过 getter / setter 读写；
     · 三个键带年级前缀（pep3s / pep4s / pep5s）与错题集编号（g3s / g4s / g5s），
       由页面注入 NS / DEFAULT_BANK，本机已有存档不受影响；
     · isSentBank、IPA_MAP（吃本页 DATA.words + SHARED_IPA）、openWrongBook 弹窗；
     · interactions 里所有按钮绑定。
   依赖 flashcard-core.js（sentChunks / segParse），必须先加载。
   ------------------------------------------------------------------ */
(function(){
  'use strict';
  const FC = window.FlashcardCore;
  if (!FC) throw new Error('flashcard-sent.js 需要先加载 flashcard-core.js');
  const { sentChunks, segParse, spoken } = FC;

  function create(env) {
    /* 稳定引用：页面里的函数声明与常量表不会换人 */
    const $ = env.$, esc = env.esc;
    const toast = env.toast, closeModal = env.closeModal, openModal = env.openModal;
    const showCard = env.showCard, scopeWords = env.scopeWords, isSentBank = env.isSentBank;
    const shuffle = env.shuffle, renderProgress = env.renderProgress, autoSpeak = env.autoSpeak;
    const loadRound = env.loadRound, saveRound = env.saveRound;
    const IPA = env.IPA, ROLE_COLOR = env.ROLE_COLOR;
    const MAX_TRY = env.MAX_TRY, SIZES = env.SIZES;
    const SESS_KEY = env.SESS_KEY, WRONG_KEY = env.WRONG_KEY, QUEUE_KEY = env.QUEUE_KEY;
    /* 状态由页面持有（换卡组会重赋值），每次现取；对象本身的属性照常写 */
    const getSent = env.getSent, getPuzzle = env.getPuzzle;
    const getWrong = env.getWrong, setWrong = env.setWrong;
    const getRound = env.getRound, getScope = env.getScope;
    const setIdx = env.setIdx, setDeck = env.setDeck;
    const SLOT_CV = document.createElement('canvas').getContext('2d');

/* 三年级页的错题 / 测试记录标记成 g3s，四五年级以后各自用自己的编号，互不混淆 */
function sentBankId(){ return (env.BANK&&env.BANK.bank)||env.DEFAULT_BANK; }
function sentTok(s){ return String(s||'').toLowerCase().replace(/[’‘]/g,"'").replace(/[^a-z0-9']/g,''); }
function sentIpa(t){ return env.IPA[String(t||'').toLowerCase().replace(/[^a-z']/g,'')]||''; }
/* ---------- 断词：保留前后标点，连字符词不拆 ---------- */
/* sentChunks 在 flashcard-core.js：断词保留前后标点，连字符词不拆 */
/* ---------- 唯一 id ---------- */
function sentGuid(){
  try{ if(window.crypto&&crypto.randomUUID) return crypto.randomUUID(); }catch(e){}
  return 's-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,10);
}
/* ---------- 会话存档 ---------- */
function sentSessKey(){ const SENT = env.getSent(); const scope = env.getScope(); return env.SESS_KEY+'|'+env.P.active+'|'+env.BANK.id+'|'+sentBankId()+'|'+scope+'|'+SENT.kind+'|'+SENT.size; }
function sentSaveSess(){
  const SENT = env.getSent();
  try{ localStorage.setItem(sentSessKey(),JSON.stringify({list:SENT.list,i:SENT.i,right:SENT.right,
    guid:SENT.guid,t0:SENT.t0,items:SENT.items})); }catch(e){}
}
function sentReadSess(){
  try{ const o=JSON.parse(localStorage.getItem(sentSessKey())||'null');
    return (o&&Array.isArray(o.list)&&o.list.length)?o:null; }catch(e){ return null; }
}
function sentDropSess(){ try{ localStorage.removeItem(sentSessKey()); }catch(e){} }

/* ---------- 开一组新题 ---------- */
function sentNewSession(o){
  const SENT = env.getSent();
  o=o||{};
  if(o.kind) SENT.kind=o.kind;
  if(o.size) SENT.size=o.size;
  const pool0=(o.pool||env.scopeWords()).map(w=>w.id||w).filter(id=>env.BY_ID[id]);
  if(!pool0.length){ env.toast('这里还没有可练的句子'); return false; }
  const uniq=[...new Set(pool0)];
  if(!env.getRound()) env.loadRound();
  const ROUND = env.getRound();
  // 本轮没出现过的优先；整表抽完才重新洗牌（题集没写完不重复）
  const fresh=env.shuffle(uniq.filter(id=>!ROUND.seen[id]));
  const used=env.shuffle(uniq.filter(id=>ROUND.seen[id]));
  const list=fresh.concat(used).slice(0,Math.min(SENT.size,uniq.length));
  if(!list.length) return false;
  list.forEach(id=>{ ROUND.seen[id]=true; });
  if(uniq.every(id=>ROUND.seen[id])){ ROUND.seen={}; list.forEach(id=>{ ROUND.seen[id]=true; }); env.saveRound(); }
  else env.saveRound();
  sentSavePref();
  SENT.list=list; SENT.i=0; SENT.right=0; SENT.items=[]; SENT.tries=0;
  SENT.answered=false; SENT.hint=false; SENT.guid=sentGuid(); SENT.t0=Date.now();
  env.setIdx(0); env.setDeck(list.slice());
  env.closeModal();
  sentSaveSess();
  env.showCard();
  return true;
}
/* 恢复上一次没做完的那一组；没有就新开一组（不负责渲染） */
function sentReadPref(){
  const SENT = env.getSent();
  try{
    const o=JSON.parse(localStorage.getItem(env.NS+'_sent_pref|'+env.P.active)||'null');
    if(o&&env.SIZES.indexOf(Number(o.size))>=0) SENT.size=Number(o.size);
    if(o&&(o.kind==='dictation'||o.kind==='puzzle')) SENT.kind=o.kind;
  }catch(e){}
}
function sentSavePref(){
  const SENT = env.getSent();
  try{ localStorage.setItem(env.NS+'_sent_pref|'+env.P.active,JSON.stringify({kind:SENT.kind,size:SENT.size})); }catch(e){}
}
function sentEnsureSession(force){
  const SENT = env.getSent();
  if(force){ sentNewSession({silent:true}); sentSavePref(); return; }
  sentReadPref();
  const saved=sentReadSess();
  if(saved && saved.list.length && saved.i<saved.list.length){
    SENT.list=saved.list; SENT.i=saved.i; SENT.right=saved.right||0;
    SENT.guid=saved.guid||sentGuid(); SENT.t0=saved.t0||Date.now(); SENT.items=saved.items||[];
    env.setDeck(SENT.list.slice()); env.setIdx(SENT.i);
    sentRenderWrongCount();
    return;
  }
  if(!SENT.list.length) sentNewSession({silent:true});
  sentRenderWrongCount();
}
/* 把光标放回第一个还没写的空格（点已选中的「句子」标签时用） */
function sentFocusFirst(){
  const SENT = env.getSent();
  if(!env.isSentBank()||SENT.kind!=='dictation'||SENT.answered) return;
  const ins=[...document.querySelectorAll('#sentSlots input')];
  const t=ins.find(i=>!i.value.trim())||ins[0];
  if(t){ try{ t.focus(); }catch(e){} }
}
/* 当前卡被切成「词块」 */
function sentWords(w){ return sentChunks(w.w); }

/* ---------- 卡片正面 ---------- */
function sentFontSize(words){
  const chars=words.reduce((a,t)=>a+t.length+2,0);
  return (words.length>15||chars>90)?'clamp(11px,2.7vw,13.5px)'
       : (words.length>10||chars>52)?'clamp(12px,3.1vw,15.5px)'
       : (words.length>7||chars>36)?'clamp(14px,3.5vw,18px)'
       : 'clamp(16px,4vw,21px)';
}
function sentRenderCard(w){
  const SENT = env.getSent();
  if(!w){ sentFinish(); return; }
  const words=sentWords(w).map(c=>c.core);
  const fs=sentFontSize(words);
  let html=`<div class="sent-cn">${esc(w.cn)}</div>`;
  if(SENT.kind==='puzzle'){
    html+=`<div class="sent-body"><div class="pz-build" id="pzBuild"></div>`+
      `<div class="pz-pool" id="pzPool"></div></div>`;
  }else{
    html+=`<div class="sent-body"><div class="sent-slots" id="sentSlots" style="--sent-fs:${fs}"><div class="sent-row">`;
    sentWords(w).forEach((c,i)=>{
      // 听写时不显示音标：/njuː/ 摆在那里等于把答案报给孩子
      html+=`<span class="sent-slot" data-i="${i}">`+
        `<span class="sent-w">${c.pre?`<b class="sent-pre">${esc(c.pre)}</b>`:''}`+
        `<input type="text" data-i="${i}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" `+
        `style="width:calc(${Math.max(2.5,c.core.length)}ch + 6px)" aria-label="第 ${i+1} 个词">`+
        `${c.suf?`<b class="sent-suf">${esc(c.suf)}</b>`:''}</span></span>`;
    });
    html+=`</div></div></div>`;
  }
  html+=`<div class="sent-bar"><span class="sent-err" id="sentErr"></span></div>`;
  const el=$('wordLine');
  el.className='word-line sent-line';
  el.style.cssText='';
  el.innerHTML=html;
  $('ipa').style.display='none'; $('segLine').style.display='none';
  SENT.tries=0; SENT.answered=false; SENT.hint=false;
  SENT.exp=words.slice();
  sentHideHint();
  if(SENT.kind==='puzzle') sentPuzzleInit(w); else { sentFitSlots(); balanceSentRows(); bindSentenceInputs(); }
  sentSyncChrome();
  setTimeout(()=>{ const f=el.querySelector('input'); if(f&&!SENT.answered) f.focus(); },80);
}
/* ---------- 拼图 ---------- */
function sentPuzzleInit(w){
  const PZ = env.getPuzzle();
  PZ.tokens=sentChunks(w.w).map(c=>c.pre+c.core+c.suf);
  PZ.pool=env.shuffle(PZ.tokens.map((t,i)=>i));
  if(PZ.pool.length>1 && PZ.tokens.every(t=>t.toLowerCase()===PZ.tokens[0].toLowerCase())){
    // 全同词也照样打乱
  }
  PZ.picked=[];
  PZ.lastSig=null;
  sentPuzzleRender();
}
function sentPuzzleRender(){
  const SENT = env.getSent();
  const PZ = env.getPuzzle();
  const b=$('pzBuild'), p=$('pzPool');
  if(!b||!p) return;
  b.innerHTML=PZ.picked.length
    ? PZ.picked.map((id,k)=>`<button type="button" class="pz-tile on" data-pick="${k}">${esc(PZ.tokens[id])}</button>`).join('')
    : `<span class="pz-tip">点下面的单词，按正确语序排上来</span>`;
  p.innerHTML=PZ.pool.map((id,k)=>`<button type="button" class="pz-tile" data-pool="${k}">${esc(PZ.tokens[id])}</button>`).join('');
  const full=PZ.picked.length===PZ.tokens.length;
  b.classList.toggle('full',full);
  const bar=$('sentErr');
  if(bar&&!SENT.answered) bar.textContent=full?'排好了？点一下空白处就交卷':'';
  b.querySelectorAll('[data-pick]').forEach(el=>{
    el.onclick=()=>{ const k=Number(el.dataset.pick); const id=PZ.picked.splice(k,1)[0]; PZ.pool.push(id); sentPuzzleRender(); };
  });
  p.querySelectorAll('[data-pool]').forEach(el=>{
    el.onclick=()=>{ const k=Number(el.dataset.pool); const id=PZ.pool.splice(k,1)[0]; PZ.picked.push(id); sentPuzzleRender(); };
  });
}
/* ---------- 逐词输入 ---------- */
/* 横线长度按「预计答案的字面宽度」实测，避免 new / welcome 这类宽字母被截掉尾字母 */
function sentFitSlots(){
  const SENT = env.getSent();
  const box=$('sentSlots'); if(!box) return;
  [...box.querySelectorAll('input')].forEach(inp=>{
    const i=Number(inp.dataset.i);
    const exp=(SENT.exp&&SENT.exp[i])||'';
    const v=inp.value||'';
    // 答对时按答案长度，答错时按已输入长度，取较长者，保证任何情况下都不裁字
    const text=v.length>exp.length?v:exp;
    const cs=getComputedStyle(inp);
    SLOT_CV.font=`${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const ls=parseFloat(cs.letterSpacing)||0;
    const tw=SLOT_CV.measureText(text).width+text.length*ls;
    const pad=(parseFloat(cs.paddingLeft)||0)+(parseFloat(cs.paddingRight)||0);
    const floor=(parseFloat(cs.fontSize)||16)*2.1;   // 极短词（a / I）也留出一段像样的横线
    inp.style.width=Math.ceil(Math.max(tw+pad+10,floor))+'px';
  });
}
function balanceSentRows(){
  const box=$('sentSlots'); if(!box) return;
  const first=box.querySelector('.sent-row'); if(!first) return;
  const slots=[...first.children].filter(el=>el.classList.contains('sent-slot'));
  if(slots.length<3) return;
  const W=Math.round(box.clientWidth||box.getBoundingClientRect().width)||0;
  if(!W) return;
  const gap=12;
  const ws=slots.map(s=>s.getBoundingClientRect().width);
  const rows=[[0]]; const rowW=[ws[0]];
  for(let i=1;i<slots.length;i++){
    const r=rows.length-1;
    if(rowW[r]+gap+ws[i]<=W+0.5){ rows[r].push(i); rowW[r]+=gap+ws[i]; }
    else { rows.push([i]); rowW.push(ws[i]); }
  }
  if(rows.length<2) return;
  for(let r=0;r<rows.length-1;r++){
    let guard=0;
    while(rows[r].length>1 && guard++<60){
      const last=rows[r][rows[r].length-1];
      const after=rowW[r]-gap-ws[last];
      const next=rowW[r+1]+gap+ws[last];
      if(next>W+0.5) break;
      if(Math.abs(after-next)>=Math.abs(rowW[r]-rowW[r+1])) break;
      rows[r].pop(); rows[r+1].unshift(last);
      rowW[r]=after; rowW[r+1]=next;
    }
  }
  const frag=document.createDocumentFragment();
  rows.forEach(row=>{
    if(!row.length) return;
    const div=document.createElement('div'); div.className='sent-row';
    row.forEach(i=>div.appendChild(slots[i]));
    frag.appendChild(div);
  });
  first.replaceWith(frag);
}
function bindSentenceInputs(){
  const SENT = env.getSent();
  const box=$('sentSlots'); if(!box) return;
  const ins=[...box.querySelectorAll('input')];
  const exp=sentChunks(env.cur?env.cur.w:'').map(c=>c.core);
  ins.forEach((inp,i)=>{
    inp.addEventListener('input',()=>{
      const slot=inp.closest('.sent-slot'); if(slot) slot.classList.remove('bad','ok');
      if(SENT.answered) return;
      sentFitSlots();
      if(exp[i] && inp.value.length>=exp[i].length && i<ins.length-1) ins[i+1].focus();
    });
    inp.addEventListener('keydown',e=>{
      if(e.isComposing||e.keyCode===229) return;
      if(e.key===' '){ e.preventDefault(); if(i<ins.length-1) ins[i+1].focus(); else sentSubmit(); return; }
      if(e.key==='Enter'){ e.preventDefault(); e.stopPropagation(); sentSubmit(); return; }
      if(e.key==='Backspace'&&!inp.value&&i>0){ e.preventDefault(); ins[i-1].focus(); const p=ins[i-1]; p.setSelectionRange(p.value.length,p.value.length); return; }
      if(e.key==='ArrowRight'&&i<ins.length-1&&inp.selectionStart===inp.value.length){ e.preventDefault(); ins[i+1].focus(); }
      if(e.key==='ArrowLeft'&&i>0&&inp.selectionStart===0){ e.preventDefault(); ins[i-1].focus(); }
      e.stopPropagation();
    });
  });
}
/* ---------- 提交 ---------- */
function sentSubmit(){
  const SENT = env.getSent();
  if(!env.isSentBank()||!env.cur) return false;
  if(SENT.answered){ sentNext(); return true; }
  if(SENT.kind==='puzzle') return sentSubmitPuzzle();
  const slots=[...document.querySelectorAll('#sentSlots .sent-slot')];
  if(!slots.length) return false;
  const exp=sentChunks(env.cur.w).map(c=>sentTok(c.core));
  // ① 没填完：回车先把光标跳到第一个空着的横线
  //    但整句一个字都没写就按回车，算一次答错（交白卷），累计到上限照样静默给出答案
  const empty=slots.filter(s=>!s.querySelector('input').value.trim());
  if(empty.length){
    const inp=empty[0].querySelector('input');
    if(inp){ inp.focus(); try{ inp.select(); }catch(e){} }
    const bar=$('sentErr');
    if(empty.length===slots.length){
      SENT.tries++;
      const box=$('sentSlots');
      if(box){ box.classList.remove('shake'); void box.offsetWidth; box.classList.add('shake'); }
      if(SENT.tries>=env.MAX_TRY){
        SENT.hint=true; sentShowHint();
        if(bar) bar.textContent='照着答案写一遍，然后回车';
      }else if(bar) bar.textContent='先想一想怎么写 · 实在不会也照常回车';
    }else if(bar) bar.textContent='还有 '+empty.length+' 个空没写，补上再回车';
    return true;
  }
  // ② 判题
  let bad=0;
  slots.forEach((s,i)=>{
    const ok=sentTok(s.querySelector('input').value)===exp[i];
    s.classList.toggle('ok',ok); s.classList.toggle('bad',!ok);
    if(!ok) bad++;
  });
  if(!bad) return sentReveal(true);
  SENT.tries++;
  const box=$('sentSlots');
  if(box){ box.classList.remove('shake'); void box.offsetWidth; box.classList.add('shake'); }
  if(SENT.tries>=env.MAX_TRY){
    // ③ 5 次没对：静默给出答案小卡片，让孩子照着补齐（不倒数、不责备）
    SENT.hint=true; sentShowHint();
    const bar=$('sentErr'); if(bar) bar.textContent='照着答案补一补';
  }else{
    const bar=$('sentErr'); if(bar) bar.textContent='有 '+bad+' 处还不对，再看看中文提示';
    const first=slots.find(s=>s.classList.contains('bad'));
    if(first){ const inp=first.querySelector('input'); if(inp){ inp.focus(); try{ inp.select(); }catch(e){} } }
  }
  return true;
}
function sentSubmitPuzzle(){
  const SENT = env.getSent();
  const PZ = env.getPuzzle();
  const exp=PZ.tokens;
  if(PZ.picked.length<exp.length){
    const bar=$('sentErr'); if(bar) bar.textContent='还有 '+(exp.length-PZ.picked.length)+' 个词没用上';
    return true;
  }
  // 顺序没动过就再点一下：不重复扣次数，提醒调一调（孩子乱点也不会白白消耗机会）
  const sig=PZ.picked.join(',');
  if(PZ.lastSig===sig){
    const bar=$('sentErr'); if(bar) bar.textContent='还是刚才那个顺序，调一调再交';
    return true;
  }
  PZ.lastSig=sig;
  const ok=PZ.picked.every((id,i)=>sentTok(PZ.tokens[id])===sentTok(exp[i]));
  if(ok) return sentReveal(true);
  SENT.tries++;
  const b=$('pzBuild');
  if(b){ b.classList.remove('shake'); void b.offsetWidth; b.classList.add('shake'); }
  if(SENT.tries>=env.MAX_TRY){
    SENT.hint=true; sentShowHint();
    const bar=$('sentErr'); if(bar) bar.textContent='照着答案排一排';
  }else{
    const bar=$('sentErr'); if(bar) bar.textContent='语序还不对，再想想先说什么';
  }
  return true;
}
/* ---------- 摊开答案（不翻转） ---------- */
function sentReveal(firstTry){
  const SENT = env.getSent();
  if(SENT.answered) return;
  SENT.answered=true;
  const w=env.cur;
  const ok=!!firstTry && SENT.tries===0;
  SENT.items.push({sentence:w.w,sentenceId:w.id,unit:w.unit,result:ok?'right':'wrong'});
  if(ok) SENT.right++;
  sentHideHint();
  const segs=segParse(w.w);
  const words=sentWords(w).map(c=>c.core);
  const fs=sentFontSize(words);
  let html='<div class="sent-head">✓ 答案</div><div class="sa-wrap" style="--sa-fs:'+fs+'">';
  if(segs){
    segs.forEach(([role,pieces])=>{
      const c=env.ROLE_COLOR[role]||'#7d948a';
      html+=`<span class="sa-chunk" style="--c:${c}"><b class="sa-role">${esc(role)}</b><span class="sa-words">`;
      pieces.forEach(p=>{
        const ipa=sentIpa(p.t.replace(/[^A-Za-z']/g,''));
        html+=`<span class="sa-unit"><span class="sa-w">${esc(p.t)}</span>`+
          `<span class="sa-ipa"><i>${ipa?'/'+esc(ipa)+'/':'&nbsp;'}</i></span></span>`;
      });
      html+='</span></span>';
    });
  }else{
    html+=`<span class="sa-chunk plain"><span class="sa-words">`;
    sentWords(w).forEach(c=>{
      const ipa=sentIpa(c.core);
      html+=`<span class="sa-unit"><span class="sa-w">${esc(c.pre+c.core+c.suf)}</span>`+
        `<span class="sa-ipa"><i>${ipa?'/'+esc(ipa)+'/':'&nbsp;'}</i></span></span>`;
    });
    html+='</span></span>';
  }
  html+='</div>';
  html+=`<div class="sa-cn">${esc(w.cn)}</div>`;
  if(SENT.hint) html+='<div class="sa-note">这次是照着答案补的，下回自己试试</div>';
  const el=$('wordLine');
  el.innerHTML=html;
  el.className='word-line sent-line revealed';
  sentSyncChrome();
  sentSaveSess();
  env.renderProgress();
  // 摊开答案后统一读一遍：不管一次答对还是照着答案补齐，孩子都能听到这句该怎么念
  setTimeout(()=>{ try{ env.autoSpeak(spoken(w.w),'example'); }catch(e){} },260);
}
function sentShowHint(){
  const box=$('sentHint');
  if(!box||!env.cur) return;
  box.innerHTML=`<div class="shc-head"><b>答案</b><button type="button" class="shc-x" aria-label="收起">×</button></div>`+
    `<div class="shc-body">${esc(env.cur.w)}</div>`;
  box.hidden=false;
  const x=box.querySelector('.shc-x'); if(x) x.onclick=sentHideHint;
}
function sentHideHint(){ const b=$('sentHint'); if(b){ b.hidden=true; b.innerHTML=''; } }
/* ---------- 下一句 / 收卷 ---------- */
function sentNext(){
  const SENT = env.getSent();
  if(!env.isSentBank()||!SENT.list.length) return;
  if(!SENT.answered){ sentSubmit(); return; }
  if(SENT.i+1>=SENT.list.length){ sentFinish(); return; }
  SENT.i++; env.setIdx(SENT.i);
  sentSaveSess();
  env.showCard();
}
function sentFinish(){
  const SENT = env.getSent();
  if(!SENT.list.length && !SENT.items.length) return;
  const scope = env.getScope();
  const total=SENT.list.length, right=SENT.right, sec=Math.round((Date.now()-SENT.t0)/1000);
  const items=SENT.items.slice();
  const payload={user:env.P.active,bank:sentBankId(),guid:SENT.guid,kind:SENT.kind,seconds:sec,
    total:total,correct:right,scope:scope==='all'?'all':String(scope),items:items};
  if(items.length) sentPostResult(payload);
  sentDropSess();
  const pct=total?Math.round(right/total*100):0;
  const mm=Math.floor(sec/60), ss=sec%60;
  env.openModal('本组完成',
    `${SENT.kind==='puzzle'?'拼图':'听写'} · ${total} 句 · 用时 ${mm} 分 ${ss} 秒`,
    `<div class="finish-box"><div class="finish-num">${right}<span>/${total}</span></div>
      <div class="finish-lbl">一次答对 · 正确率 ${pct}%</div>
      <div class="finish-bar"><i style="width:${pct}%"></i></div>
      ${items.some(x=>x.result==='wrong')?'<p class="finish-tip">没写对的句子已收进「错题集」，练对 3 次自动移出。</p>':'<p class="finish-tip">全部一次答对，漂亮。</p>'}</div>`,
    `<button class="btn" data-act="sent-wrong">看看错题集</button>
     <button class="btn primary" data-act="sent-again">再来一组</button>`);
  SENT.list=[]; SENT.i=0; SENT.items=[]; SENT.right=0;
  sentSyncChrome(); env.renderProgress(); sentRenderWrongCount();
  setTimeout(()=>{ if(!$('overlay').hidden) sentLoadWrong(true); },10);
}
/* ---------- 顶部状态（已做 / 总数） ---------- */
function sentSyncChrome(){
  const SENT = env.getSent();
  const badge=$('sentBadge');
  if(badge){
    const done=SENT.items.length, total=SENT.list.length||SENT.size;
    badge.hidden=false;
    badge.innerHTML=`已做 <b>${done}</b><i>/${total}</i>`;
    badge.classList.toggle('done',done>=total&&total>0);
  }
  const tools=$('sentTools');
  if(tools&&!tools.hidden){
    tools.querySelectorAll('[data-kind]').forEach(b=>b.classList.toggle('on',b.dataset.kind===SENT.kind));
    tools.querySelectorAll('[data-size]').forEach(b=>{
      const on=Number(b.dataset.size)===SENT.size;
      b.classList.toggle('on',on); b.setAttribute('aria-selected',on?'true':'false');
    });
    const sl=$('sentSizeLabel'); if(sl) sl.textContent=SENT.size+' 题';
  }
  sentSyncPrimary();
}
function sentSyncPrimary(){
  const SENT = env.getSent();
  const fb=$('btnFlip'); if(!fb) return;
  const txt=SENT.answered?'下一句':'提交答案';
  [...fb.childNodes].forEach(n=>{ if(n.nodeType===3&&n.textContent.trim()) n.textContent=txt; });
  fb.title=SENT.answered?'下一句（快捷键 Enter）':'提交答案（快捷键 Enter）';
  sentSyncFrontHint();
}
/* 正面底部提示：随练法（听写/拼图）与答题状态变化 */
function sentSyncFrontHint(){
  const SENT = env.getSent();
  const h=$('frontHint'); if(!h||env.BANK.id!=='sentence') return;
  const pz=SENT.kind==='puzzle';
  h.textContent=(pz?'点单词，按正确语序排好':'看中文，把英文写出来')+' · 回车'+(SENT.answered?'下一句':'检查');
}
function sentCacheWrong(list){
  const SENT_WRONG = Array.isArray(list) ? list : env.getWrong();
  env.setWrong(SENT_WRONG);
  try{ localStorage.setItem(env.WRONG_KEY+'|'+env.P.active+'|'+sentBankId(),JSON.stringify({t:Date.now(),items:SENT_WRONG})); }catch(e){}
  sentRenderWrongCount();
}
function sentReadWrongCache(){
  try{
    const o=JSON.parse(localStorage.getItem(env.WRONG_KEY+'|'+env.P.active+'|'+sentBankId())||'null');
    if(o&&Array.isArray(o.items)) env.setWrong(o.items);
  }catch(e){}
}
function sentRenderWrongCount(){
  const SENT = env.getSent();
  const SENT_WRONG = env.getWrong();
  const n=SENT_WRONG.filter(w=>w.kind===SENT.kind).length;
  const b=$('btnWrong'); if(b){ const el=b.querySelector('b'); if(el) el.textContent=n; b.classList.toggle('has',n>0); }
}
function sentLoadWrong(force){
  sentReadWrongCache();
  if(force) sentRenderWrongCount();
}
function sentPostResult(payload){
  // 独立发布版：成绩与错题全在本机维护，规则与 sentence_api.py 一致——
  // 错的入集并把连对清零；对的 +1，同一种练法连对 3 次整条移出。
  const items=Array.isArray(payload.items)?payload.items:[];
  if(!items.length) return;
  const kind=payload.kind||'dictation';
  const list=getWrong().slice();
  for(const it of items){
    const sentence=String(it.sentence||'').trim();
    if(!sentence) continue;
    const at=list.findIndex(w=>w.kind===kind&&w.sentence===sentence);
    if(it.result==='wrong'){
      const row={sentence,sentenceId:String(it.sentenceId||''),unit:Number(it.unit)||0,kind,streak:0};
      if(at<0) list.push(row);
      else { row.streak=0; list[at]=row; }
    }else if(at>=0){
      const n=Number(list[at].streak||0)+1;
      if(n>=3) list.splice(at,1);
      else list[at].streak=n;
    }
  }
  sentCacheWrong(list);
}
function sentFlushQueue(){
  // 单机版没有补传队列；顺手清掉旧版本留在 localStorage 的队列。
  try{ localStorage.setItem(env.QUEUE_KEY,'[]'); }catch(e){}
}
function sentWrongUnitLabel(u){ const x=env.UNITS[u-1]; return x?x.label:'其他'; }

/* ---------- 本组题量浮层（句子） ---------- */
function sentSizePopSet(open){
  const wrap=$('sentSize'), pop=$('sentSizePop'), btn=$('sentSizeBtn');
  if(!wrap||!pop||!btn) return;
  pop.hidden=!open; wrap.classList.toggle('open',!!open);
  btn.setAttribute('aria-expanded',open?'true':'false');
}

    return {
        sentBankId,
        sentTok,
        sentIpa,
        sentGuid,
        sentSessKey,
        sentSaveSess,
        sentReadSess,
        sentDropSess,
        sentNewSession,
        sentReadPref,
        sentSavePref,
        sentEnsureSession,
        sentFocusFirst,
        sentWords,
        sentFontSize,
        sentRenderCard,
        sentPuzzleInit,
        sentPuzzleRender,
        sentFitSlots,
        balanceSentRows,
        bindSentenceInputs,
        sentSubmit,
        sentSubmitPuzzle,
        sentReveal,
        sentShowHint,
        sentHideHint,
        sentNext,
        sentFinish,
        sentSyncChrome,
        sentSyncPrimary,
        sentSyncFrontHint,
        sentCacheWrong,
        sentReadWrongCache,
        sentRenderWrongCount,
        sentLoadWrong,
        sentPostResult,
        sentFlushQueue,
        sentWrongUnitLabel,
        sentSizePopSet
    };
  }

  window.FlashcardSent = { create: create };
})();
