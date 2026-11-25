/* ==========================================================================
   英语闪卡 · 纯函数层（flashcard-core.js）
   三年级 / 四年级 / 五年级三页共用这一份；页面只留数据与差异，不再各抄一遍。

   这里只放「给什么算什么」的纯函数：
     · 朗读文本与拼写判定：lw / spoken / normSpell / dictTokens
     · 句子断词与成分解析：sentChunks / segToks / segIsVerb / segParse（含 SEG_* 词典）
     · 存档结构：blankBank / blankState / validUnit / normBank / activeBank / normalizeProfile
     · 快捷键判定：isSlashKey / isTextInput / isRightKey / isUpKey / isEnterKey
   不碰 DOM、不读写 localStorage、不认识任何具体卡组；卡组与单元数由页面用 cfg 传入。

   约定：函数体与页面原实现逐字一致（只有 normalizeProfile 为了吃 cfg 重写过，行为等价，
   由 _merge_work/o3/core_probe.py 的「抽取前 / 抽取后」行为快照逐字比对）。
   改这里的任何一个函数，三页同时生效——改完跑
     python tools/flashcard_drift.py --against _merge_work/o3/drift-baseline.json
   确认「新增」为 0，再跑三套听写 / 句子测试。
   ========================================================================== */
(function (global) {
  'use strict';

  /* ---------- 朗读文本 / 拼写判定 / 短语分格 ---------- */
  const lw = s => String(s).toLowerCase().replace(/’/g,"'");

  /* 短语里的 … 是课本占位符，朗读时跳过；弯引号统一成直引号 */
  function spoken(t){ return String(t==null?'':t).replace(/…/g,'').replace(/’/g,"'").replace(/\s+/g,' ').trim(); }

  function normSpell(s){ return lw(s).trim().replace(/['’-]/g,'').replace(/[^a-z ]/g,''); }

  function dictTokens(w){
    // 课本里的 … 是占位符（如 put…in…），分词时当空格处理，别把两个词粘成一个
    let s=spoken(String((w&&w.w)||'').replace(/…/g,' '));
    const cut=s.indexOf('/');
    if(cut>0) s=s.slice(0,cut);
    const toks=s.split(/\s+/).filter(t=>/[A-Za-z0-9]/.test(t));
    return toks.length?toks:[spoken(w&&w.w)];
  }

  /* ---------- 句子断词 ---------- */
  /* 纯符号（… / ... / —— / 单独的 ? ! ）不是要填的词，不能占横线、也不参与判题：
     课本里「We often cook together and ...」这种句子，孩子只需写到 and 就够。
     处理办法：符号贴到左边那个词的 suf 上当后缀；句子开头的符号先攒着，挂到下一个词的 pre。 */
  function sentChunks(s){
    const out=[];
    let lead='';
    String(s||'').split(/\s+/).filter(Boolean).forEach(raw=>{
      if(!/[A-Za-z0-9]/.test(raw)){
        if(out.length) out[out.length-1].suf+=' '+raw;
        else lead+=' '+raw;
        return;
      }
      const m=raw.match(/^([^A-Za-z0-9]*)([A-Za-z0-9][A-Za-z0-9'’\-]*)([^A-Za-z0-9]*)$/);
      const c=m?{pre:m[1]||'',core:m[2],suf:m[3]||''}:{pre:'',core:raw,suf:''};
      if(lead){ c.pre=lead.replace(/^\s+/,'')+c.pre; lead=''; }
      out.push(c);
    });
    // 极端情况：整句都是符号（数据里没有，真出现也照原样给一个块，别让页面卡死）
    if(!out.length) return String(s||'').trim()? [{pre:'',core:String(s),suf:''}] : [];
    if(lead) out[out.length-1].suf+=lead;
    return out;
  }

  /* ---------- 句子成分解析：SEG 词典 + 保守解析（疑问句 / 并列句 / 无动词返回 null，交给整句平铺） ---------- */
  const SEG_BE=new Set(['am','is','are','was','were','be','being','been']);
  const SEG_LINK=new Set(['look','looks','sound','sounds','become','becomes','grow','grows','seem','seems']);
  const SEG_MODAL=new Set(['can',"can't",'cant','could','must','may','might','will','would','should','shall',"won't","wouldn't","couldn't"]);
  const SEG_DO=new Set(['do','does','did',"don't","doesn't","didn't"]);
  const SEG_HAVE=new Set(['have','has','had',"haven't","hasn't"]);
  const SEG_VERBS=new Set(('act answer ask beat begin bring buy call care carry catch choose clean climb close come cook '+
    'count cry cut dance describe discuss draw drink drive eat enjoy exercise express fall feed feel find finish fly '+
    'follow get give go grow guess happen hear help hold hop jump keep know learn leave like listen live look love make '+
    'meet need open pass pay pick place plant play point put rain read repeat ride run say see sell send share show sing '+
    'sit sleep smell smile speak stand start stay stop study swim take talk taste teach tell thank think throw touch try '+
    'turn use visit wait wake walk want wash watch water wave wear welcome work write let').split(' '));
  [SEG_BE,SEG_LINK,SEG_MODAL,SEG_DO,SEG_HAVE].forEach(set=>set.forEach(w=>SEG_VERBS.add(w)));
  ['let',"let's"].forEach(w=>SEG_VERBS.add(w));
  const SEG_FUSE=/^(i|you|he|she|it|we|they|that|this|there|what|who|name|mum|dad)('(?:s|m|re|d|ll|ve))$/;
  const SEG_PREP=new Set(['in','on','at','to','with','from','for','of','under','over','near','by','about','into','onto',
    'behind','between','around','after','before','like','as','than','up','down','out','off','through','across']);
  const SEG_MID=new Set(['also','only','still','always','never','just','really','often','sometimes']);
  const SEG_LEAD=new Set(['now','then','today','here','also','again','sometimes','often','always','still','only','just','later','next','first','soon']);
  const SEG_INTERJ=new Set(['yes','no','oh','well','ok','okay','sure','hi','hello','thanks','sorry','wow','hey']);
  const SEG_WH=new Set(['what',"what's",'where',"where's",'who',"who's",'whose','how','which','when','why']);
  const SEG_CONJ=new Set(['and','but','or','because','so','if']);
  const SEG_DET=new Set(['a','an','the','my','our','your','his','her','its','their','some','any','this','that','these','those',
    'two','three','four','five','six','seven','eight','nine','ten','one']);
  const SEG_TRAIL=new Set(['together','too','now','again','here','there','well','aloud','back','soon','today','every','more','all']);
  const SEG_COMP=new Set(['grow','run','jump','sing','dance','play','eat','drink','sleep','sit','stand','swim','fly','cry',
    'smile','work','look','come','go','help','open','close','clean']);
  function segToks(s){
    const out=[];
    let lead='';
    String(s||'').split(/\s+/).forEach(raw=>{
      if(!raw) return;
      if(!/\w/.test(raw)){                      // 纯符号同上：贴到前一个词尾，不单独充当「词」
        if(out.length) out[out.length-1].suf+=' '+raw;
        else lead+=' '+raw;
        return;
      }
      const m=raw.match(/^([^\w'’]*)([\w'’\-]+)([^\w'’]*)$/);
      if(!m){
        out.push({pre:lead.replace(/^\s+/,''),w:raw,suf:'',low:raw.toLowerCase()});
        lead='';
        return;
      }
      out.push({pre:lead.replace(/^\s+/,'')+m[1],w:m[2],suf:m[3],low:m[2].toLowerCase().replace(/’/g,"'")});
      lead='';
    });
    if(lead && out.length) out[out.length-1].suf+=lead;
    return out;
  }
  function segIsVerb(t){ const w=t.low.replace(/’/g,"'"); return SEG_VERBS.has(w)||SEG_FUSE.test(w); }
  function segParse(sentence){
    const ts=segToks(sentence);
    if(!ts.length) return null;
    const lows=ts.map(t=>t.low);
    if(String(sentence).indexOf('?')>=0 || !ts.some(segIsVerb)) return null;
    if(SEG_WH.has(lows[0]) || lows.slice(1).indexOf("what's")>=0 || lows.slice(1).indexOf("who's")>=0) return null;
    for(let i=0;i<ts.length;i++){
      if(i===0 || !SEG_CONJ.has(ts[i].low)) continue;
      if(ts.slice(i+1).some(segIsVerb)) return null;
    }
    const segs=[];
    const add=(role,list)=>{ if(list&&list.length) segs.push([role,list]); };
    const pc=(i,text,role)=>{
      const d={t:(text===undefined||text===null)?ts[i].w:text,src:i};
      if(role) d.role=role;
      return d;
    };
    let endCall=[], lastComma=-1;
    ts.forEach((t,i)=>{ if(t.suf.charAt(0)===',') lastComma=i; });
    if(lastComma>=0 && lastComma<ts.length-1){
      const seg=ts.slice(lastComma+1);
      const prev=ts[lastComma].w;
      if(seg.every(t=>/^[A-Z]/.test(t.w)) && !/^[A-Z]/.test(prev) && ts.slice(0,lastComma+1).some(segIsVerb)){
        endCall=[]; for(let i=lastComma+1;i<ts.length;i++) endCall.push(i);
      }
    }
    const T=endCall.length?ts.slice(0,endCall[0]):ts;
    const n=T.length;
    if(!n) return null;
    let idx=0;
    while(idx<n){
      const low=T[idx].low;
      if(idx===0 && SEG_CONJ.has(low) && !T[idx].pre){ add('连词',[pc(idx)]); idx++; }
      else if(SEG_LEAD.has(low) && !segIsVerb(T[idx])){ add('状语',[pc(idx)]); idx++; }
      else if(SEG_INTERJ.has(low)){ add('独立成分',[pc(idx)]); idx++; }
      else if(T[idx].suf.charAt(0)===',' && /^[A-Z]/.test(T[idx].w)){ add('称呼',[pc(idx)]); idx++; }
      else break;
    }
    const rest=[]; for(let i=idx;i<n;i++) rest.push(i);
    if(!rest.length) return null;
    let vi=-1;
    for(let k=0;k<rest.length;k++){
      const i=rest[k];
      if(!segIsVerb(T[i])) continue;
      if(k>0 && T[rest[k-1]].low==='to') continue;
      if(k>0 && SEG_DET.has(T[rest[k-1]].low) && !SEG_FUSE.test(T[i].low)) continue;
      vi=k; break;
    }
    if(vi<0) return null;
    const subjI=rest.slice(0,vi);
    const subj=subjI.filter(i=>!SEG_MID.has(T[i].low));
    const mid=subjI.filter(i=>SEG_MID.has(T[i].low));
    const first=T[rest[vi]];
    const fm=first.low.match(SEG_FUSE);
    let pred=[], k=vi, fuseBe=false;
    if(fm && fm[1]!=='there'){
      const head=first.w.slice(0,fm[1].length), suf=first.w.slice(head.length);
      add('主语', subj.map(i=>pc(i)).concat([pc(rest[vi],head)]));
      pred=[pc(rest[vi],suf,'谓语')];
      k=vi+1;
      fuseBe=["'m","'s","'re"].indexOf(suf.toLowerCase())>=0;
    }else if(subj.length){
      add('主语', subj.map(i=>pc(i)));
    }
    if(mid.length) add('状语', mid.map(i=>pc(i)));
    while(k<rest.length && !fuseBe){
      const i=rest[k], low=T[i].low;
      if(SEG_MID.has(low) || low==='not'){
        if(!pred.length) break;
        pred.push(pc(i,null,'谓语')); k++; continue;
      }
      if(!segIsVerb(T[i])) break;
      pred.push(pc(i,null,'谓语')); k++;
      if(SEG_MODAL.has(low) || SEG_DO.has(low) || low==='let' || low==="let's" || SEG_FUSE.test(low)) continue;
      if(SEG_BE.has(low) || low==="'m" || low==="'s" || low==="'re") break;
      if(SEG_HAVE.has(low) && k<rest.length && segIsVerb(T[rest[k]])) continue;
      break;
    }
    add('谓语', pred);
    const tail=rest.slice(k);
    if(!tail.length){
      if(endCall.length) add('称呼', endCall.map(i=>pc(i)));
      return segs;
    }
    const vIsBe=pred.some(p=>SEG_BE.has(p.t.toLowerCase())||SEG_LINK.has(p.t.toLowerCase())||
      ["'m","'s","'re"].indexOf(p.t.toLowerCase())>=0);
    let cut=-1;
    tail.forEach((i,j)=>{ if(cut<0 && j>0 && (SEG_PREP.has(T[i].low)||SEG_TRAIL.has(T[i].low))) cut=j; });
    const head=cut<0?tail:tail.slice(0,cut);
    if(vIsBe && SEG_PREP.has(T[tail[0]].low)){
      add('状语', tail.map(i=>pc(i)));
    }else if(vIsBe){
      add('表语', head.map(i=>pc(i)));
      if(cut>=0) add('状语', tail.slice(cut).map(i=>pc(i)));
    }else if(SEG_PREP.has(T[tail[0]].low) || (SEG_TRAIL.has(T[tail[0]].low) && tail.length===1)){
      add('状语', tail.map(i=>pc(i)));
    }else{
      let comp=-1;
      head.forEach((i,j)=>{
        if(comp<0 && j>0 && segIsVerb(T[i]) && !SEG_DET.has(T[head[j-1]].low) && SEG_COMP.has(T[i].low)) comp=j;
      });
      if(comp<0){
        add('宾语', head.map(i=>pc(i)));
      }else{
        add('宾语', head.slice(0,comp).map(i=>pc(i)));
        add('补语', head.slice(comp).map(i=>pc(i)));
      }
      if(cut>=0) add('状语', tail.slice(cut).map(i=>pc(i)));
    }
    if(endCall.length) add('称呼', endCall.map(i=>pc(i)));
    return segs;
  }
  /* == SEG:END == */

  /* ---------- 存档结构（纯数据，不碰 localStorage） ---------- */
  function blankBank(){ return {fav:{},mastered:{},seen:{},streak:{},hits:{},unit:1}; }
  function blankState(){ return Object.assign(blankBank(),{rate:.82,voiceURI:'',mode:'word',banks:{}}); }
  function validUnit(u,max){ return u==='all' || (Number.isInteger(u)&&u>=1&&u<=max); }
  function normBank(d,max){
    const b=Object.assign(blankBank(),(d&&typeof d==='object')?d:{});
    ['fav','mastered','seen','streak','hits'].forEach(k=>{ if(!b[k]||typeof b[k]!=='object') b[k]={}; });
    if(!validUnit(b.unit,max)) b.unit=1;
    return b;
  }

  function activeBank(s){ return s.mode==='word'? s : (s.banks[s.mode] || (s.banks[s.mode]=blankBank())); }

  /* 存档规整：cfg = {units: 单词卡组单元数, banks: [{id, units}]}。
     原实现直接读页面里的 BANK_BY_ID / BANKS / DATA，这里改成由页面喂进来，
     核心不认识任何具体卡组；行为与原来一致（未知 mode 归位 word，单元越界归 1）。 */
  function normalizeProfile(d, cfg) {
    cfg = cfg || {};
    const banks = cfg.banks || [];
    const s = Object.assign(blankState(), (d && typeof d === 'object') ? d : {});
    ['fav', 'mastered', 'seen', 'streak', 'hits'].forEach(k => { if (!s[k] || typeof s[k] !== 'object') s[k] = {}; });
    if (typeof s.rate !== 'number' || s.rate < .5 || s.rate > 1.2) s.rate = .82;
    if (typeof s.voiceURI !== 'string') s.voiceURI = '';
    if (!s.banks || typeof s.banks !== 'object') s.banks = {};
    if (!(s.mode === 'word' || banks.some(b => b.id === s.mode))) s.mode = 'word';
    s.unit = normBank({unit: s.unit}, cfg.units || 1).unit;
    banks.forEach(b => { s.banks[b.id] = normBank(s.banks[b.id], b.units || 1); });
    return s;
  }

  /* ---------- 快捷键判定 ---------- */
  function isSlashKey(e){
    if(e.code) return e.code==='Slash' || e.code==='NumpadDivide';
    return e.key==='/' || e.key==='?' || e.key==='÷';
  }

  function isTextInput(el){
    if(!el) return false;
    if(el.isContentEditable) return true;
    const tag=(el.tagName||'').toUpperCase();
    if(tag==='TEXTAREA'||tag==='SELECT') return true;
    if(tag==='INPUT'){
      const t=(el.type||'text').toLowerCase();
      return ['text','search','url','tel','email','password','number','date','time','datetime-local','month','week'].indexOf(t)>=0;
    }
    return false;
  }

  function isRightKey(e){
    return e.key==='ArrowRight' || e.key==='Right' || e.code==='ArrowRight' || e.keyCode===39;
  }
  function isUpKey(e){
    return e.key==='ArrowUp' || e.key==='Up' || e.code==='ArrowUp' || e.keyCode===38;
  }
  function isEnterKey(e){
    return e.key==='Enter' || e.code==='Enter' || e.code==='NumpadEnter' || e.keyCode===13;
  }

  global.FlashcardCore = {
    lw: lw, spoken: spoken, normSpell: normSpell, dictTokens: dictTokens,
    sentChunks: sentChunks, segToks: segToks, segIsVerb: segIsVerb, segParse: segParse,
    blankBank: blankBank, blankState: blankState, validUnit: validUnit,
    normBank: normBank, activeBank: activeBank, normalizeProfile: normalizeProfile,
    isSlashKey: isSlashKey, isTextInput: isTextInput,
    isRightKey: isRightKey, isUpKey: isUpKey, isEnterKey: isEnterKey
  };
})(window);
