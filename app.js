/* ============================================================
   EDU ASSISTANT — Trợ lý theo dõi lớp học cho giáo viên
   Gồm 4 phần: Lớp học · Buổi học · Báo cáo · Tiến độ
   ------------------------------------------------------------
   Lưu trữ:
   - Mỗi giáo viên đăng nhập bằng ID + mật khẩu riêng (Firebase Auth).
   - Dữ liệu lưu ngay trên thiết bị (localStorage + bộ đệm Firestore)
     để mở nhanh và dùng được khi mất mạng, rồi tự đồng bộ lên
     Firestore khi có mạng — mở trên máy khác vẫn thấy đủ dữ liệu.
   - Chưa điền firebase-config.js → app chạy chế độ "chỉ trên máy này".
============================================================ */
const APP_NAME = 'EDU ASSISTANT';
const APP_VERSION = '1.0.1';
const LOGIN_EMAIL_DOMAIN = 'edu-assistant.app'; // ID không có @ sẽ được ghép thành id@edu-assistant.app

/* ============================================================
   FIREBASE
============================================================ */
function readFirebaseConfig(){
  const c = window.EDU_FIREBASE_CONFIG;
  if(!c || !c.apiKey || !c.projectId) return null;
  if(/YOUR_|DIEN_|<|xxx/i.test(c.apiKey + c.projectId)) return null;
  return c;
}
const FIREBASE_CONFIG = readFirebaseConfig();
let fbAuth = null, fbDB = null;
try{
  if(FIREBASE_CONFIG && typeof firebase !== 'undefined'){
    firebase.initializeApp(FIREBASE_CONFIG);
    fbAuth = firebase.auth();
    fbDB = firebase.firestore();
    // Bộ đệm ngoại tuyến của Firestore: đọc được khi mất mạng, thay đổi được xếp hàng và tự gửi lên khi có mạng lại
    fbDB.enablePersistence({synchronizeTabs:true}).catch(()=>{ /* trình duyệt không hỗ trợ — vẫn còn lớp đệm localStorage */ });
  }
}catch(e){ console.error('Không khởi tạo được Firebase:', e); fbAuth = null; fbDB = null; }
function cloudEnabled(){ return !!(fbAuth && fbDB); }

function loginIdToEmail(id){
  id = (id||'').trim().toLowerCase();
  return id.includes('@') ? id : `${id}@${LOGIN_EMAIL_DOMAIN}`;
}
function displayIdOf(user){
  if(!user) return 'Máy này';
  const email = user.email || '';
  return email.endsWith('@'+LOGIN_EMAIL_DOMAIN) ? email.slice(0, -(LOGIN_EMAIL_DOMAIN.length+1)) : email;
}
function authErrorMessage(err){
  const code = (err && err.code) || '';
  const map = {
    'auth/invalid-credential':'ID hoặc mật khẩu chưa đúng.',
    'auth/invalid-login-credentials':'ID hoặc mật khẩu chưa đúng.',
    'auth/wrong-password':'Mật khẩu chưa đúng.',
    'auth/user-not-found':'Chưa có tài khoản với ID này — bấm "Tạo tài khoản" nhé.',
    'auth/email-already-in-use':'ID này đã có người dùng, cô chọn ID khác nhé.',
    'auth/weak-password':'Mật khẩu cần ít nhất 6 ký tự.',
    'auth/invalid-email':'ID không hợp lệ (chỉ dùng chữ không dấu, số, dấu chấm, gạch ngang).',
    'auth/network-request-failed':'Không có mạng — cần kết nối Internet cho lần đăng nhập đầu tiên.',
    'auth/too-many-requests':'Thử sai quá nhiều lần, đợi vài phút rồi thử lại.',
    'auth/operation-not-allowed':'Firebase chưa bật đăng nhập Email/Password (xem README).',
    'auth/requires-recent-login':'Cần đăng nhập lại trước khi đổi mật khẩu.',
  };
  return map[code] || ('Có lỗi: ' + ((err && err.message) || 'không rõ nguyên nhân'));
}

/* ============================================================
   KHO DỮ LIỆU: localStorage (đệm trên máy) + Firestore (đám mây)
   Mỗi khoá lưu dạng {value: string, t: thời điểm sửa}. Khi mở app,
   bản nào mới hơn (máy hay mây) thì dùng bản đó.
============================================================ */
const store = {
  uid: null,        // null = chế độ chỉ trên máy
  map: {},          // key -> {v, t}
  pending: 0,
  prefix(){ return `eduassistant:${this.uid || 'local'}:`; },
  remoteCol(){ return fbDB.collection('users').doc(this.uid).collection('data'); },

  loadLocal(){
    this.map = {};
    const p = this.prefix();
    try{
      for(let i=0;i<localStorage.length;i++){
        const k = localStorage.key(i);
        if(!k || !k.startsWith(p)) continue;
        try{ const obj = JSON.parse(localStorage.getItem(k)); if(obj && typeof obj.v==='string') this.map[k.slice(p.length)] = obj; }catch(e){}
      }
    }catch(e){}
  },
  writeLocal(key, entry){
    try{
      if(entry===null) localStorage.removeItem(this.prefix()+key);
      else localStorage.setItem(this.prefix()+key, JSON.stringify(entry));
    }catch(e){ showToast('Bộ nhớ trình duyệt đã đầy — nên xuất file sao lưu.', 4000); }
  },

  async init(uid){
    this.uid = uid || null;
    this.loadLocal();
    if(!this.uid || !cloudEnabled()) return;
    let snaps = null;
    try{
      snaps = await withTimeout(this.remoteCol().get({source:'server'}), 9000, null);
      if(!snaps) snaps = await withTimeout(this.remoteCol().get({source:'cache'}), 3000, null);
    }catch(e){ snaps = null; }
    if(!snaps){ setSyncStatus('offline'); return; }
    const remoteKeys = new Set();
    snaps.forEach(doc=>{
      const d = doc.data() || {};
      remoteKeys.add(doc.id);
      const local = this.map[doc.id];
      const rt = Number(d.t || d.updatedAt || 0);
      if(d.deleted){
        if(!local || local.t <= rt){ delete this.map[doc.id]; this.writeLocal(doc.id, null); }
        return;
      }
      if(typeof d.v !== 'string') return;
      if(!local || local.t < rt){ this.map[doc.id] = {v:d.v, t:rt}; this.writeLocal(doc.id, this.map[doc.id]); }
      else if(local.t > rt){ this.pushRemote(doc.id, local); }
    });
    // Dữ liệu nhập lúc ngoại tuyến mà trên mây chưa có → đẩy lên
    Object.keys(this.map).forEach(k=>{ if(!remoteKeys.has(k)) this.pushRemote(k, this.map[k]); });
    setSyncStatus(navigator.onLine ? 'synced' : 'offline');
  },

  get(key){ const e = this.map[key]; return e ? e.v : null; },
  keys(prefix){ return Object.keys(this.map).filter(k=>k.startsWith(prefix)); },

  set(key, value){
    const cur = this.map[key];
    if(cur && cur.v === value) return;              // không đổi → không ghi
    const entry = {v:value, t:Date.now()};
    this.map[key] = entry;
    this.writeLocal(key, entry);
    if(this.uid && cloudEnabled()) this.pushRemote(key, entry);
  },
  remove(key){
    if(!(key in this.map)) return;
    delete this.map[key];
    this.writeLocal(key, null);
    if(this.uid && cloudEnabled()) this.pushRemote(key, {deleted:true, t:Date.now()});
  },
  pushRemote(key, entry){
    this.pending++;
    setSyncStatus(navigator.onLine ? 'saving' : 'offline');
    const data = entry.deleted ? {deleted:true, t:entry.t} : {v:entry.v, t:entry.t};
    this.remoteCol().doc(key).set(data)
      .then(()=>{ this.pending = Math.max(0, this.pending-1); if(!this.pending) setSyncStatus('synced'); })
      .catch(err=>{
        this.pending = Math.max(0, this.pending-1);
        console.error('Lỗi đồng bộ', key, err);
        setSyncStatus('error');
      });
  },
};

function withTimeout(promise, ms, fallback){
  return new Promise(resolve=>{
    let done = false;
    const timer = setTimeout(()=>{ if(!done){ done = true; resolve(fallback); } }, ms);
    Promise.resolve(promise).then(v=>{ if(!done){ done=true; clearTimeout(timer); resolve(v); } })
      .catch(()=>{ if(!done){ done=true; clearTimeout(timer); resolve(fallback); } });
  });
}

const SYNC_LABEL = {
  local:  {cls:'off',  text:'💻 Chỉ lưu trên máy này'},
  synced: {cls:'ok',   text:'☁️ Đã đồng bộ'},
  saving: {cls:'busy', text:'⏳ Đang lưu lên mây…'},
  offline:{cls:'warn', text:'📴 Ngoại tuyến — sẽ tự đồng bộ khi có mạng'},
  error:  {cls:'err',  text:'⚠ Chưa đồng bộ được — kiểm tra Firestore Rules'},
};
let syncStatus = 'local';
function setSyncStatus(s){
  syncStatus = s;
  document.querySelectorAll('[data-sync-pill]').forEach(p=>{
    const info = SYNC_LABEL[s] || SYNC_LABEL.local;
    p.className = 'sync-pill ' + info.cls;
    p.textContent = info.text;
  });
}
window.addEventListener('online', ()=>{ if(store.uid) setSyncStatus(store.pending ? 'saving' : 'synced'); });
window.addEventListener('offline', ()=>{ if(store.uid) setSyncStatus('offline'); });

/* ============================================================
   STATE
============================================================ */
const state = {
  classes: [],            // [{id,name,students:[{id,name}]}]
  sessionsByClass: {},    // { classId: [session,...] }
  tab: 'session',
  currentClassId: null,
  session: { date: todayISO(), prompt:'', sortKey:'default', sortDir:'desc' },
  report: { classId:null, studentId:null, mode:'student', infographicDate:null, infographicPrompt:'', infographicScoreMode:'top' },
  progress: { classId:null, studentId:null, query:'' },
  globalSearch: '',
  loaded:false,
  modal:null,
  teacherName: '',
  // đăng nhập
  authReady:false,
  setupIssue:null,   // 'no-config' | 'no-sdk'
  user:null,
  authMode:'login',   // 'login' | 'register'
  authBusy:false,
  authError:'',
};

function todayISO(){
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function uid(){ return 'id_' + Math.random().toString(36).slice(2,10) + Date.now().toString(36); }
function fmtDateVN(iso){
  const [y,m,d] = iso.split('-');
  return `${d}/${m}/${y}`;
}
function clamp(n,min,max){ return Math.max(min, Math.min(max, n)); }
function safeParse(raw, fallback){ try{ return raw ? JSON.parse(raw) : fallback; }catch(e){ return fallback; } }

/* ============================================================
   LƯU / NẠP
   Buổi học được chia theo tháng: "sess__<classId>__<YYYY-MM>"
   để mỗi bản ghi trên Firestore luôn nhỏ (giới hạn 1MB/bản ghi).
============================================================ */
const _saveTimers = {};
function debouncedSet(key, value, delay){
  clearTimeout(_saveTimers[key]);
  _saveTimers[key] = setTimeout(()=>{ delete _saveTimers[key]; store.set(key, value); }, delay || 500);
}
function flushPendingSaves(){
  Object.keys(_saveTimers).forEach(k=>{ clearTimeout(_saveTimers[k]); delete _saveTimers[k]; });
  saveClassesNow();
  Object.keys(state.sessionsByClass).forEach(saveSessionsNow);
  store.set('teacherName', state.teacherName || '');
}
window.addEventListener('pagehide', ()=>{ if(state.loaded) flushPendingSaves(); });

function sessKey(classId, month){ return `sess__${classId}__${month}`; }

function loadAll(){
  state.classes = safeParse(store.get('classes'), []);
  state.teacherName = store.get('teacherName') || '';
  state.sessionsByClass = {};
  store.keys('sess__').forEach(k=>{
    const parts = k.split('__');
    if(parts.length !== 3) return;
    const classId = parts[1];
    const list = safeParse(store.get(k), []);
    if(!state.sessionsByClass[classId]) state.sessionsByClass[classId] = [];
    state.sessionsByClass[classId].push(...list);
  });
  if(!state.classes.find(c=>c.id===state.currentClassId)) state.currentClassId = state.classes.length ? state.classes[0].id : null;
  state.tab = state.classes.length ? 'session' : 'classes';
  state.loaded = true;
}
function saveClassesNow(){ store.set('classes', JSON.stringify(state.classes)); }
function saveClasses(){ debouncedSet('classes', JSON.stringify(state.classes)); }
function saveTeacherName(){ debouncedSet('teacherName', state.teacherName || ''); }

function sessionsByMonth(classId){
  const groups = {};
  (state.sessionsByClass[classId]||[]).forEach(s=>{ const m = s.date.slice(0,7); (groups[m] = groups[m] || []).push(s); });
  return groups;
}
function saveSessionsNow(classId){
  const groups = sessionsByMonth(classId);
  Object.keys(groups).forEach(m=> store.set(sessKey(classId,m), JSON.stringify(groups[m])));
  store.keys(`sess__${classId}__`).forEach(k=>{ if(!groups[k.split('__')[2]]) store.remove(k); });
}
function saveSessions(classId){
  clearTimeout(_saveTimers['__sess_'+classId]);
  _saveTimers['__sess_'+classId] = setTimeout(()=>{ delete _saveTimers['__sess_'+classId]; saveSessionsNow(classId); }, 500);
}
function removeClassSessions(classId){
  store.keys(`sess__${classId}__`).forEach(k=> store.remove(k));
}

/* ---------- Sao lưu / khôi phục bằng file ---------- */
function getLastBackupAt(){ try{ return localStorage.getItem(store.prefix()+'__lastBackup'); }catch(e){ return null; } }
function setLastBackupAt(){ try{ localStorage.setItem(store.prefix()+'__lastBackup', new Date().toISOString()); }catch(e){} }

function exportBackup(){
  const backup = {
    app: 'EduAssistant', version: 1, exportedAt: new Date().toISOString(),
    classes: state.classes,
    sessionsByClass: state.sessionsByClass,
    teacherName: state.teacherName,
  };
  const blob = new Blob([JSON.stringify(backup, null, 2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `EduAssistant-SaoLuu-${todayISO()}.json`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
  setLastBackupAt();
  showToast('Đã xuất file sao lưu.');
  render();
}

// Nhận cả file sao lưu của EduAssistant lẫn EduTrack (bản đầy đủ) — chỉ lấy lớp, học sinh, buổi học.
function importBackup(file){
  const reader = new FileReader();
  reader.onload = (e)=>{
    const data = safeParse(e.target.result, null);
    if(!data || !Array.isArray(data.classes)){ showToast('File không đúng định dạng sao lưu.'); return; }
    openConfirmModal('Khôi phục từ file này sẽ GHI ĐÈ toàn bộ lớp, học sinh và buổi học hiện có trong tài khoản. Tiếp tục?', true, ()=>{
      const oldIds = state.classes.map(c=>c.id);
      state.classes = data.classes.map(c=>({id:c.id, name:c.name, students:(c.students||[]).map(s=>({id:s.id, name:s.name}))}));
      state.sessionsByClass = data.sessionsByClass || {};
      if(data.teacherName) state.teacherName = data.teacherName;
      oldIds.forEach(removeClassSessions);
      state.currentClassId = state.classes.length ? state.classes[0].id : null;
      saveClassesNow();
      Object.keys(state.sessionsByClass).forEach(saveSessionsNow);
      store.set('teacherName', state.teacherName || '');
      render();
      showToast('Đã khôi phục dữ liệu từ file.');
    });
  };
  reader.readAsText(file, 'utf-8');
}

/* ============================================================
   DATA HELPERS
============================================================ */
function getClass(id){ return state.classes.find(c=>c.id===id); }
function getStudents(classId){ const c = getClass(classId); return c ? c.students : []; }
function getSessions(classId){ return (state.sessionsByClass[classId]||[]).slice().sort((a,b)=> a.date.localeCompare(b.date)); }

// Học sinh có đang "nợ" chép phạt tính đến trước ngày `beforeDate` hay không:
// duyệt các buổi trước đó theo thứ tự thời gian, giao chép phạt thì bật nợ, kiểm tra xong thì tắt nợ.
function studentOwesPunishment(classId, studentId, beforeDate){
  const sessions = getSessions(classId).filter(s=>s.date < beforeDate);
  let owes = false;
  sessions.forEach(s=>{
    if(s.punishmentAssigned && s.punishmentAssigned[studentId]) owes = true;
    if(s.punishmentDone && s.punishmentDone[studentId]) owes = false;
  });
  return owes;
}
function getPendingPunishments(classId, beforeDate){
  return getStudents(classId).filter(st=>studentOwesPunishment(classId, st.id, beforeDate));
}


function newSession(date){
  return {
    id: uid(), date,
    content:'', generalNote:'', disciplineNote:'', homework:'',
    attendance:{}, studentNotes:{},
    exerciseTypes:[],   // checklist loại bài (tri-state)
    checklist:{},       // {studentId: {exTypeId: 'full'|'partial'|'none'}}
    exercises:[],        // [{id,name,totalQuestions}] bài luyện tập có điểm số
    scores:{},           // {studentId: {exerciseId: số câu đúng}}
    rating:{},           // {studentId: 1..5}
    punishmentAssigned:{}, // {studentId: true} - giao chép phạt ở buổi này
    punishmentDone:{},     // {studentId: true} - đã kiểm tra/nộp chép phạt ở buổi này
  };
}

// Điểm 1 bài luyện tập. 2 kiểu:
// - "fraction" (mặc định, tương thích dữ liệu cũ): nhập số câu đúng, quy đổi sang thang 10.
// - "scale10": nhập thẳng điểm theo thang 10, cho phép thập phân 1 chữ số.
function exerciseTotal(ex){ return (ex && ex.totalQuestions) ? ex.totalQuestions : 10; }
function exerciseMode(ex){ return (ex && ex.mode==='scale10') ? 'scale10' : 'fraction'; }
function scoreOn10(correct, total){
  if(correct===null || correct===undefined || correct==='' || !total) return null;
  return clamp((Number(correct)/total)*10, 0, 10);
}
// Điểm hiển thị/tính toán cho 1 bài luyện tập của 1 học sinh, tự chọn công thức theo kiểu bài
function exerciseScoreOn10(ex, raw){
  if(raw===null || raw===undefined || raw==='') return null;
  if(exerciseMode(ex)==='scale10') return clamp(Number(raw), 0, 10);
  return scoreOn10(raw, exerciseTotal(ex));
}

function sessionScoreAvg(session, studentId){
  const sc = session.scores[studentId];
  if(!sc) return null;
  const vals = [];
  Object.keys(sc).forEach(exId=>{
    const ex = (session.exercises||[]).find(e=>e.id===exId);
    const s10 = exerciseScoreOn10(ex, sc[exId]);
    if(s10!==null) vals.push(s10);
  });
  if(!vals.length) return null;
  return vals.reduce((a,b)=>a+b,0)/vals.length;
}
function sessionClassAvg(session, studentIds){
  const vals = studentIds.map(id=>sessionScoreAvg(session,id)).filter(v=>v!==null);
  if(!vals.length) return null;
  return vals.reduce((a,b)=>a+b,0)/vals.length;
}
// Tỷ lệ % học sinh có mặt trong 1 buổi cụ thể (trên số học sinh đã điểm danh buổi đó)
function sessionAttendanceRate(session, studentIds){
  let present=0, total=0;
  studentIds.forEach(id=>{
    const a = session.attendance[id];
    if(!a) return;
    total++;
    if(a==='present') present++;
  });
  return total ? Math.round(present/total*100) : null;
}
// Tỷ lệ % hoàn thành checklist bài tập của cả lớp trong 1 buổi cụ thể
function sessionChecklistRate(session, studentIds){
  if(!session.exerciseTypes || !session.exerciseTypes.length) return null;
  let full=0, partial=0, total=0;
  studentIds.forEach(id=>{
    const rec = session.checklist[id] || {};
    session.exerciseTypes.forEach(t=>{
      const v = rec[t.id] || 'none';
      total++;
      if(v==='full') full++;
      else if(v==='partial') partial++;
    });
  });
  return total ? Math.round(((full + partial*0.5)/total)*100) : null;
}

function attendanceFromSessions(sessions, studentId){
  let present=0, absent=0, late=0, total=0;
  sessions.forEach(s=>{
    const a = s.attendance[studentId];
    if(!a) return;
    total++;
    if(a==='present') present++;
    else if(a==='absent') absent++;
    else if(a==='late') late++;
  });
  return {present, absent, late, total, rate: total? Math.round((present)/total*100) : null};
}
function studentAttendanceStats(classId, studentId){
  return attendanceFromSessions(getSessions(classId), studentId);
}
function monthKey(dateStr){ return dateStr.slice(0,7); } // YYYY-MM
function monthLabel(key){
  const [y,m] = key.split('-');
  return `Tháng ${Number(m)}/${y}`;
}
function getClassMonths(classId){
  const sessions = getSessions(classId);
  const keys = Array.from(new Set(sessions.map(s=>monthKey(s.date))));
  return keys.sort();
}

function checklistFromSessions(sessions, studentId){
  let full=0, partial=0, none=0, total=0;
  sessions.forEach(s=>{
    if(!s.exerciseTypes || !s.exerciseTypes.length) return;
    const rec = s.checklist[studentId] || {};
    s.exerciseTypes.forEach(t=>{
      const v = rec[t.id] || 'none';
      total++;
      if(v==='full') full++;
      else if(v==='partial') partial++;
      else none++;
    });
  });
  const rate = total? Math.round(((full + partial*0.5)/total)*100) : null;
  return {full, partial, none, total, rate};
}
function studentChecklistStats(classId, studentId){
  return checklistFromSessions(getSessions(classId), studentId);
}

// Danh sách bài kiểm tra/luyện tập có điểm + bài tập (checklist) gần đây của 1 học sinh, mới nhất trước
function studentRecentItems(classId, studentId, limit){
  const sessions = getSessions(classId);
  const items = [];
  sessions.forEach(s=>{
    (s.exercises||[]).forEach(e=>{
      const raw = (s.scores[studentId]||{})[e.id];
      if(raw===undefined || raw===null || raw==='') return;
      const score10 = exerciseScoreOn10(e, raw);
      if(score10===null) return;
      const label = score10>=8?'Tốt': score10>=6.5?'Khá': score10>=5?'Đạt':'Cần cố gắng';
      items.push({date:s.date, name:e.name || 'Bài kiểm tra', type:'Kiểm tra/Luyện tập', scoreText: score10.toFixed(1)+'/10', statusText: label});
    });
    (s.exerciseTypes||[]).forEach(t=>{
      const v = (s.checklist[studentId]||{})[t.id];
      if(!v) return;
      const label = v==='full'?'Hoàn thành đầy đủ': v==='partial'?'Hoàn thành một phần':'Chưa làm';
      items.push({date:s.date, name:t.name || 'Bài tập về nhà', type:'BTVN', scoreText:'—', statusText: label});
    });
  });
  items.sort((a,b)=> a.date < b.date ? 1 : (a.date > b.date ? -1 : 0));
  return limit ? items.slice(0, limit) : items;
}

function studentScoreSeries(classId, studentId){
  const sessions = getSessions(classId);
  const students = getStudents(classId).map(s=>s.id);
  const out = [];
  sessions.forEach(s=>{
    const my = sessionScoreAvg(s, studentId);
    if(my===null) return;
    out.push({ date:s.date, score: my, classAvg: sessionClassAvg(s, students) });
  });
  return out;
}

function getWarnings(classId){
  const warns = [];
  const students = getStudents(classId);
  const sessions = getSessions(classId);
  students.forEach(st=>{
    // consecutive absences (last 2+ recorded sessions)
    const attended = sessions.filter(s=> s.attendance[st.id]);
    if(attended.length>=2){
      const lastTwo = attended.slice(-2);
      if(lastTwo.every(s=>s.attendance[st.id]==='absent')){
        warns.push({studentId:st.id, name:st.name, type:'absence', detail:`Vắng ${lastTwo.length} buổi liên tiếp gần đây nhất`});
      }
    }
    // declining scores (last 3 sessions strictly decreasing)
    const series = studentScoreSeries(classId, st.id);
    if(series.length>=3){
      const last3 = series.slice(-3);
      if(last3[0].score > last3[1].score && last3[1].score > last3[2].score){
        warns.push({studentId:st.id, name:st.name, type:'decline', detail:`Điểm giảm dần 3 buổi gần nhất: ${last3.map(x=>x.score.toFixed(1)).join(' → ')}`});
      }
    }
  });
  return warns;
}
/* ============================================================
   MODAL (thay thế prompt()/confirm() bị trình duyệt chặn)
============================================================ */
function openPromptModal(title, defaultValue, onSubmit, opts){
  opts = opts || {};
  state.modal = {type:'prompt', title, value: defaultValue || '', onSubmit, password: !!opts.password, multiline: !!opts.multiline, placeholder: opts.placeholder || '', hint: opts.hint || '', submitLabel: opts.submitLabel || 'Lưu', showListTip: !!opts.showListTip};
  render();
  setTimeout(()=>{ const i = document.getElementById('modal-input'); if(i){ i.focus(); if(i.select) i.select(); } }, 30);
}
function openConfirmModal(title, danger, onSubmit){
  state.modal = {type:'confirm', title, danger, onSubmit};
  render();
}
function closeModal(){ state.modal = null; render(); }
function renderModal(){
  if(!state.modal) return '';
  const m = state.modal;
  if(m.type==='prompt'){
    const field = m.multiline
      ? `<textarea id="modal-input" rows="9" placeholder="${esc(m.placeholder)}" style="font-family:'Be Vietnam Pro',sans-serif;">${esc(m.value)}</textarea>`
      : `<input type="${m.password?'password':'text'}" id="modal-input" value="${esc(m.value)}" placeholder="${esc(m.placeholder)}" data-action="modal-input" ${m.password?'autocomplete="off"':''}>`;
    return `
    <div class="modal-backdrop no-print" data-action="modal-backdrop">
      <div class="modal" data-stop="1" style="${m.multiline?'width:440px;':''}">
        <h3>${esc(m.title)}</h3>
        ${m.hint? `<div class="muted" style="margin:-8px 0 12px;">${esc(m.hint)}</div>` : ''}
        ${field}
        ${m.multiline && m.showListTip? `<div class="tiny" style="margin-top:6px;">Mẹo: chọn cả danh sách trong Excel/Word rồi dán trực tiếp vào ô trên (Ctrl+Enter để lưu nhanh).</div>` : ''}
        <div class="modal-actions">
          <button class="btn btn-outline" data-action="modal-cancel">Huỷ</button>
          <button class="btn btn-accent" data-action="modal-submit">${esc(m.submitLabel)}</button>
        </div>
      </div>
    </div>`;
  }
  return `
  <div class="modal-backdrop no-print" data-action="modal-backdrop">
    <div class="modal" data-stop="1">
      <h3>${esc(m.title)}</h3>
      <div class="modal-actions">
        <button class="btn btn-outline" data-action="modal-cancel">Huỷ</button>
        <button class="btn ${m.danger?'btn-danger-outline':'btn-accent'}" style="${m.danger?'background:var(--danger);color:#fff;border-color:var(--danger);':''}" data-action="modal-submit">Đồng ý</button>
      </div>
    </div>
  </div>`;
}

/* ============================================================
   RENDER SHELL
============================================================ */
function el(html){ const d=document.createElement('div'); d.innerHTML=html; return d.firstElementChild; }
function esc(s){ return (s||'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function chalkUnderline(color){
  color = color || 'var(--pencil)';
  return `<svg class="chalk-underline" viewBox="0 0 56 8" fill="none"><path d="M1 5.5C10 2 18 7 27 4C36 1 45 6 55 3" stroke="${color}" stroke-width="3.2" stroke-linecap="round"/></svg>`;
}
/* ============================================================
   CLASSES
============================================================ */
function renderClasses(){
  const cur = getClass(state.currentClassId);
  return `
    <div class="topbar">
      <div><h1 class="page-title">Lớp học</h1>${chalkUnderline()}<div class="page-sub">Quản lý danh sách lớp và học sinh</div></div>
      <button class="btn btn-accent" data-action="add-class">+ Thêm lớp</button>
    </div>
    <div class="grid-2">
      <div class="card">
        <div class="card-title">Danh sách lớp</div>
        ${state.classes.length? state.classes.map(c=>`
          <div style="display:flex;align-items:center;justify-content:space-between;padding:9px 0;border-bottom:1px solid var(--line);">
            <div style="cursor:pointer;flex:1;" data-action="select-class" data-id="${c.id}">
              <div style="font-weight:600; ${c.id===state.currentClassId?'color:var(--accent-deep);':''}">${esc(c.name)}</div>
              <div class="tiny">${c.students.length} học sinh</div>
            </div>
            <button class="btn btn-outline btn-sm" data-action="rename-class" data-id="${c.id}">Sửa tên</button>
            <button class="btn btn-danger-outline btn-sm" data-action="delete-class" data-id="${c.id}">Xoá</button>
          </div>
        `).join('') : `<div class="muted">Chưa có lớp nào.</div>`}
      </div>
      <div class="card">
        <div class="card-title">
          <span>Học sinh ${cur? '— '+esc(cur.name) : ''}</span>
          ${cur? `<button class="btn btn-accent btn-sm" data-action="add-student">+ Thêm học sinh</button>`:''}
        </div>
        ${!cur ? `<div class="muted">Chọn một lớp bên trái để xem danh sách học sinh.</div>` :
          (cur.students.length? `
            <table><thead><tr><th>#</th><th>Họ tên</th><th></th></tr></thead><tbody>
            ${cur.students.map((s,i)=>`
              <tr class="ledger">
                <td class="mono">${i+1}</td>
                <td>${esc(s.name)}</td>
                <td style="text-align:right;">
                  <button class="btn btn-outline btn-sm" data-action="rename-student" data-id="${s.id}">Sửa</button>
                  <button class="btn btn-danger-outline btn-sm" data-action="delete-student" data-id="${s.id}">Xoá</button>
                </td>
              </tr>`).join('')}
            </tbody></table>` : `<div class="muted">Lớp chưa có học sinh nào.</div>`)
        }
      </div>
    </div>
  `;
}

/* ============================================================
   SESSION (TRÊN LỚP)
============================================================ */
function currentSession(){
  const list = state.sessionsByClass[state.currentClassId] || [];
  let s = list.find(x=>x.date===state.session.date);
  return s || null;
}
function ensureSessionEditable(){
  if(!state.currentClassId) return null;
  let list = state.sessionsByClass[state.currentClassId] || (state.sessionsByClass[state.currentClassId]=[]);
  let s = list.find(x=>x.date===state.session.date);
  if(!s){ s = newSession(state.session.date); list.push(s); }
  return s;
}

function renderSession(){
  if(!state.classes.length){
    return `<div class="topbar"><h1 class="page-title">Buổi học</h1></div><div class="card empty"><h3>Chưa có lớp học</h3><div class="muted">Hãy tạo lớp và thêm học sinh trước.</div></div>`;
  }
  const students = getStudents(state.currentClassId);
  const s = currentSession();

  const classOptions = state.classes.map(c=>`<option value="${c.id}" ${c.id===state.currentClassId?'selected':''}>${esc(c.name)}</option>`).join('');

  let body;
  if(!students.length){
    body = `<div class="card empty"><h3>Lớp này chưa có học sinh</h3><div class="muted">Vào tab "Lớp học" để thêm danh sách học sinh.</div></div>`;
  } else {
    const sess = s || newSession(state.session.date);
    const warns = getWarnings(state.currentClassId);
    const warnSet = {}; warns.forEach(w=> warnSet[w.studentId]=true);
    const pending = getPendingPunishments(state.currentClassId, state.session.date);
    const pendingSet = {}; pending.forEach(p=> pendingSet[p.id]=true);
    const types = sess.exerciseTypes || [];
    const exercises = sess.exercises || [];
    const colCount = 3 + types.length + exercises.length; // Học sinh + Điểm danh + Chép phạt + Ghi chú + động

    const sortKey = state.session.sortKey || 'default';
    const sortDir = state.session.sortDir || 'desc';
    const sortExercise = exercises.find(e=>e.id===sortKey);
    function sortValueOf(studentId){
      if(sortKey==='avg') return sessionScoreAvg(sess, studentId);
      if(sortExercise){
        const raw = (sess.scores[studentId]||{})[sortExercise.id];
        return exerciseScoreOn10(sortExercise, raw);
      }
      return null;
    }
    let orderedStudents = students;
    if(exercises.length && sortKey !== 'default'){
      const withScore = students.map(st=>({st, val: sortValueOf(st.id)}));
      withScore.sort((a,b)=>{
        if(a.val===null && b.val===null) return 0;
        if(a.val===null) return 1;
        if(b.val===null) return -1;
        return sortDir==='desc' ? b.val-a.val : a.val-b.val;
      });
      orderedStudents = withScore.map(x=>x.st);
    }

    body = `
      ${pending.length ? `
      <div class="warn-banner" style="margin-bottom:16px;">
        <div class="dot"></div>
        <div style="flex:1;">
          <div class="warn-title">📌 Cần kiểm tra chép phạt buổi này</div>
          <div class="warn-detail">${pending.map(p=>esc(p.name)).join(', ')} — còn nợ chép phạt từ buổi trước. Tick cột "✅ Đã KT" ở bảng bên dưới khi đã nộp.</div>
        </div>
      </div>` : ''}

      <div class="card">
        <div class="card-title">📝 Ghi chú buổi học</div>
        <div class="grid-2">
          <div>
            <label class="field-label">Nội dung học tập</label>
            <textarea rows="2" placeholder="VD: Unit 5 - Present Perfect, luyện nói theo cặp..." data-field="content">${esc(sess.content)}</textarea>
          </div>
          <div>
            <label class="field-label">Nhận xét về nền nếp</label>
            <textarea rows="2" placeholder="VD: Lớp học nghiêm túc, một số em nói chuyện riêng..." data-field="disciplineNote">${esc(sess.disciplineNote||'')}</textarea>
          </div>
          <div>
            <label class="field-label">Lưu ý của buổi học <span class="tiny">(mỗi dòng 1 ý)</span></label>
            <textarea rows="2" placeholder="VD: Cần luyện thêm phát âm âm cuối..." data-field="generalNote">${esc(sess.generalNote)}</textarea>
          </div>
          <div>
            <label class="field-label">Bài tập về nhà <span class="tiny">(mỗi dòng 1 bài)</span></label>
            <textarea rows="2" placeholder="VD: Làm bài tập Unit 5 trang 20..." data-field="homework">${esc(sess.homework||'')}</textarea>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">⚙️ Thiết lập Checklist bài tập</div>
        <div class="chip-row" style="margin-bottom:8px;">
          ${types.map(t=>`<div class="chip">${esc(t.name)} <button data-action="del-extype" data-id="${t.id}">×</button></div>`).join('') || `<span class="tiny">Chưa có loại bài nào.</span>`}
        </div>
        <div style="display:flex; gap:8px; max-width:420px;">
          <input type="text" id="new-extype" placeholder="VD: Phiếu bài tập, Đặt câu...">
          <button class="btn btn-outline btn-sm" data-action="add-extype">+ Thêm</button>
        </div>
      </div>

      <div class="card">
        <div class="card-title">
          <span>📋 Bảng ghi nhận buổi học</span>
          <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
            ${exercises.length? `
            <select data-action="session-sort-key" style="width:auto;">
              <option value="default" ${sortKey==='default'?'selected':''}>Không sắp xếp</option>
              <option value="avg" ${sortKey==='avg'?'selected':''}>Sắp xếp theo: Điểm TB buổi</option>
              ${exercises.map(e=>`<option value="${e.id}" ${sortKey===e.id?'selected':''}>Sắp xếp theo: ${esc(e.name)}</option>`).join('')}
            </select>
            ${sortKey!=='default'? `
            <select data-action="session-sort-dir" style="width:auto;">
              <option value="desc" ${sortDir==='desc'?'selected':''}>Cao → thấp</option>
              <option value="asc" ${sortDir==='asc'?'selected':''}>Thấp → cao</option>
            </select>` : ''}` : ''}
            ${exercises.length? `<button class="btn btn-danger-outline btn-sm" data-action="reset-scores">↺ Đặt lại điểm buổi này</button>`:''}
          </div>
        </div>
        <div class="muted" style="margin-bottom:10px;">Checklist: bấm ô để chuyển Chưa làm → Làm thiếu → Đầy đủ. Dùng nút "Tick tất cả" ở tiêu đề cột để làm nhanh cả lớp, rồi chỉnh lại từng em ngoại lệ. Cuộn ngang nếu bảng rộng hơn màn hình — cột "Học sinh" luôn cố định.</div>

        <div style="border:1px solid var(--line); border-radius:8px; padding:10px 12px; margin-bottom:14px; background:var(--surface-alt);">
          <div class="chip-row" style="margin-bottom:${exercises.length?'8px':'0'};">
            ${exercises.map(e=>`<div class="chip">${esc(e.name)} · ${exerciseMode(e)==='scale10' ? 'thang 10' : exerciseTotal(e)+' câu'} <button data-action="del-exercise" data-id="${e.id}">×</button></div>`).join('')}
          </div>
          <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
            <input type="text" id="new-exercise" placeholder="+ Tên bài luyện tập mới..." style="flex:2;min-width:140px;">
            <select id="new-exercise-mode" style="flex:1;min-width:150px;">
              <option value="fraction">Theo số câu đúng/tổng</option>
              <option value="scale10">Thang 10</option>
            </select>
            <input type="number" id="new-exercise-total" placeholder="Tổng số câu" min="1" step="1" style="flex:1;min-width:90px;">
            <button class="btn btn-outline btn-sm" data-action="add-exercise">+ Thêm bài luyện tập</button>
          </div>
        </div>

        <div style="overflow-x:auto;">
        <table class="session-table" style="min-width:${560 + (types.length+exercises.length)*90}px;">
          <thead>
            <tr>
              <th rowspan="2" style="min-width:130px;">Học sinh</th>
              <th rowspan="2" style="min-width:150px;">
                Điểm danh<br>
                <button class="btn btn-outline btn-sm" data-action="tick-all-attendance" style="margin-top:4px;font-size:10.5px;padding:3px 7px;font-weight:600;text-transform:none;letter-spacing:0;">✓ Tất cả có mặt</button>
              </th>
              ${types.length? `<th colspan="${types.length}" style="text-align:center;">Checklist bài tập</th>` : ''}
              ${exercises.length? `<th colspan="${exercises.length}" style="text-align:center;">Điểm luyện tập</th>` : ''}
              <th rowspan="2" style="min-width:130px;">📌 Chép phạt</th>
              <th rowspan="2" style="min-width:280px;">Ghi chú riêng</th>
            </tr>
            <tr>
              ${types.map(t=>`<th style="text-align:center;min-width:80px;">
                ${esc(t.name)}<br>
                <button class="btn btn-outline btn-sm" data-action="tick-all-checklist" data-type="${t.id}" style="margin-top:4px;font-size:10.5px;padding:3px 6px;font-weight:600;text-transform:none;letter-spacing:0;">✓ Đủ tất cả</button>
              </th>`).join('')}
              ${exercises.map(e=>`<th style="text-align:center;min-width:90px;">${esc(e.name)}<div class="tiny" style="text-transform:none;letter-spacing:0;">(${exerciseMode(e)==='scale10' ? 'thang 10' : exerciseTotal(e)+' câu'})</div></th>`).join('')}
            </tr>
          </thead>
          <tbody>
          ${orderedStudents.map(st=>{
            const a = sess.attendance[st.id] || '';
            const owes = pendingSet[st.id] || false;
            const done = !!(sess.punishmentDone||{})[st.id];
            const assigned = !!(sess.punishmentAssigned||{})[st.id];
            return `<tr class="ledger ${warnSet[st.id]||owes?'flagged':''}">
              <td><b>${esc(st.name)}</b></td>
              <td>
                <div class="seg" data-attendance-group="${st.id}">
                  <button class="${a==='present'?'on present':''}" title="Có mặt" data-action="set-att" data-student="${st.id}" data-value="present">✓</button>
                  <button class="${a==='absent'?'on absent':''}" title="Vắng" data-action="set-att" data-student="${st.id}" data-value="absent">✗</button>
                  <button class="${a==='late'?'on late':''}" title="Muộn" data-action="set-att" data-student="${st.id}" data-value="late">⏰</button>
                </div>
              </td>
              ${(()=>{ const isAbsent = a==='absent'; return `
              ${types.map(t=>{
                if(isAbsent){
                  return `<td style="text-align:center;"><div class="tick" title="Học sinh vắng mặt — không cần nhập" style="background:var(--surface-alt);color:var(--ink-faint);cursor:not-allowed;">—</div></td>`;
                }
                const v = (sess.checklist[st.id]||{})[t.id] || 'none';
                const label = v==='full'?'✓':(v==='partial'?'½':'—');
                return `<td style="text-align:center;"><div class="tick ${v}" data-action="cycle-check" data-student="${st.id}" data-type="${t.id}">${label}</div></td>`;
              }).join('')}
              ${exercises.map(e=>{
                const mode = exerciseMode(e);
                const total = exerciseTotal(e);
                const v = (sess.scores[st.id]||{})[e.id];
                if(isAbsent){
                  return `<td style="text-align:center;"><input class="score-input" type="number" value="" placeholder="Vắng" disabled title="Học sinh vắng mặt — không cần nhập" style="background:var(--surface-alt);color:var(--ink-faint);cursor:not-allowed;"></td>`;
                }
                if(mode==='scale10'){
                  return `<td style="text-align:center;">
                    <input class="score-input" type="number" min="0" max="10" step="0.1" value="${v!==undefined?v:''}" placeholder="0-10" data-action="set-score" data-student="${st.id}" data-exercise="${e.id}" data-total="${total}" data-mode="scale10">
                  </td>`;
                }
                const computed = exerciseScoreOn10(e, v);
                return `<td style="text-align:center;">
                  <div style="display:flex;flex-direction:column;align-items:center;gap:2px;">
                    <input class="score-input" type="number" min="0" max="${total}" step="1" value="${v!==undefined?v:''}" placeholder="0-${total}" data-action="set-score" data-student="${st.id}" data-exercise="${e.id}" data-total="${total}" data-mode="fraction">
                    <span class="tiny mono score-computed">${computed!==null? computed.toFixed(1)+'/10' : '—'}</span>
                  </div>
                </td>`;
              }).join('')}
              `; })()}
              <td>
                <div style="display:flex; flex-direction:column; gap:4px; font-size:12.5px;">
                  ${owes? `<label style="display:flex;align-items:center;gap:4px;cursor:pointer;color:var(--danger);"><input type="checkbox" ${done?'checked':''} data-action="toggle-punishment-done" data-student="${st.id}"> Đã KT</label>` : ''}
                  <label style="display:flex;align-items:center;gap:4px;cursor:pointer;" title="Giao chép phạt buổi này"><input type="checkbox" ${assigned?'checked':''} data-action="toggle-punishment-assign" data-student="${st.id}"> Giao mới</label>
                </div>
              </td>
              <td><textarea rows="2" placeholder="Lưu ý riêng..." style="width:100%;min-width:260px;resize:vertical;white-space:pre-wrap;" data-action="set-note" data-student="${st.id}">${esc(sess.studentNotes[st.id]||'')}</textarea></td>
            </tr>`;
          }).join('')}
          </tbody>
        </table>
        </div>
      </div>

      ${exercises.length ? `
      <div class="card">
        <div class="card-title">📊 Tổng kết buổi</div>
        <div class="muted" style="margin-bottom:10px;">Điểm cao nhất/thấp nhất/trung bình của cả lớp cho từng bài luyện tập — tự cập nhật ngay khi cô nhập điểm ở bảng trên.</div>
        <table>
          <thead><tr><th>Bài luyện tập</th><th style="text-align:center;">Cao nhất</th><th style="text-align:center;">Thấp nhất</th><th style="text-align:center;">Trung bình lớp</th></tr></thead>
          <tbody>
          ${exercises.map(e=>{
            const vals = students.map(st=>exerciseScoreOn10(e, (sess.scores[st.id]||{})[e.id])).filter(v=>v!==null);
            const max = vals.length? Math.max(...vals) : null;
            const min = vals.length? Math.min(...vals) : null;
            const avg = vals.length? vals.reduce((a,b)=>a+b,0)/vals.length : null;
            return `<tr class="ledger" data-summary-exercise="${e.id}">
              <td>${esc(e.name)}</td>
              <td class="mono summary-max" style="text-align:center;">${max!==null?max.toFixed(1):'—'}</td>
              <td class="mono summary-min" style="text-align:center;">${min!==null?min.toFixed(1):'—'}</td>
              <td class="mono summary-avg" style="text-align:center;font-weight:700;color:var(--accent-deep);">${avg!==null?avg.toFixed(1):'—'}</td>
            </tr>`;
          }).join('')}
          </tbody>
        </table>
      </div>` : ''}
    `;
  }

  return `
    <div class="topbar">
      <div><h1 class="page-title">Buổi học</h1>${chalkUnderline()}<div class="page-sub">Ghi nhận điểm danh, bài tập và đánh giá theo từng buổi</div></div>
    </div>
    <div class="card" style="display:flex; gap:16px; align-items:flex-end; flex-wrap:wrap;">
      <div>
        <label class="field-label">Lớp</label>
        <select class="class-select" data-action="change-class-session">${classOptions}</select>
      </div>
      <div>
        <label class="field-label">Ngày học</label>
        <input type="date" value="${state.session.date}" data-action="change-session-date" style="width:170px;">
      </div>
      <div>
        <label class="field-label">Giáo viên</label>
        <input type="text" value="${esc(state.teacherName)}" placeholder="Tên giáo viên" data-action="set-teacher-name" style="width:180px;">
      </div>
      ${currentSession()? `<button class="btn btn-danger-outline btn-sm" data-action="delete-session">🗑 Xoá buổi học này</button>`:''}
      ${currentSession()? `<button class="btn btn-outline btn-sm" data-action="generate-session-prompt" data-class="${state.currentClassId}" data-date="${state.session.date}">✨ Tạo prompt báo cáo</button>`:''}
      ${currentSession()? `<button class="btn btn-accent btn-sm" data-action="export-session-doc">⬇ Xuất báo cáo buổi học (mẫu)</button>`:''}
      <div class="muted" style="margin-left:auto;">${currentSession()? 'Đã có dữ liệu cho buổi này — mọi thay đổi tự lưu.':'Buổi mới — dữ liệu sẽ được tạo khi bạn nhập.'}</div>
    </div>
    ${body}
    ${state.session.prompt ? `
    <div class="card">
      <div class="card-title">
        <span>📝 Prompt báo cáo buổi học</span>
        <button class="btn btn-outline btn-sm" data-action="copy-session-prompt">💬 Copy prompt</button>
      </div>
      <div class="muted" style="margin-bottom:8px;">Dán prompt này vào ChatGPT/Claude/Gemini... (bản có hỗ trợ xuất file) để tạo file Word (.docx) báo cáo hoàn chỉnh, sẵn sàng in hoặc gửi đi.</div>
      <textarea id="session-prompt-text" rows="14">${esc(state.session.prompt)}</textarea>
    </div>` : ''}
  `;
}

/* ============================================================
   REPORT
============================================================ */
function generateRemark(classId, studentId){
  const att = studentAttendanceStats(classId, studentId);
  const series = studentScoreSeries(classId, studentId);
  const students = getStudents(classId);
  const lastSession = getSessions(classId).slice(-1)[0];
  let parts = [];

  if(att.total===0){ parts.push('Chưa có đủ dữ liệu điểm danh để đánh giá nền nếp.'); }
  else if(att.rate>=90) parts.push(`Nền nếp tốt, đi học đều đặn (đạt ${att.rate}% số buổi).`);
  else if(att.rate>=75) parts.push(`Nền nếp khá ổn, tuy nhiên còn ${att.absent} buổi vắng và ${att.late} buổi đi muộn cần lưu ý.`);
  else parts.push(`Cần cải thiện nền nếp: tỷ lệ đi học đạt ${att.rate}%, đã vắng ${att.absent} buổi.`);

  // Điểm danh buổi gần nhất so với buổi liền trước
  const allSess = getSessions(classId);
  if(allSess.length>=2){
    const last = allSess[allSess.length-1], prev = allSess[allSess.length-2];
    const lastA = last.attendance[studentId], prevA = prev.attendance[studentId];
    if(lastA && prevA){
      const label = (a)=> a==='present'?'có mặt': a==='absent'?'vắng':'đi muộn';
      if(lastA===prevA) parts.push(`Buổi gần nhất (${fmtDateVN(last.date)}) vẫn ${label(lastA)}, giống như buổi trước (${fmtDateVN(prev.date)}).`);
      else parts.push(`Buổi gần nhất (${fmtDateVN(last.date)}) ${label(lastA)}, trong khi buổi trước (${fmtDateVN(prev.date)}) ${label(prevA)}.`);
    }
  }

  if(series.length>=2){
    const first = series[0].score, last = series[series.length-1].score;
    if(last - first > 0.5) parts.push('Kết quả học tập có xu hướng tiến bộ rõ rệt qua các buổi.');
    else if(first - last > 0.5) parts.push('Điểm số có xu hướng giảm dần, cần được quan tâm và hỗ trợ thêm.');
    else parts.push('Kết quả học tập ổn định qua các buổi gần đây.');
  }

  if(series.length){
    const lastScore = series[series.length-1].score;
    const classAvg = series[series.length-1].classAvg;
    if(classAvg!==null){
      if(lastScore - classAvg > 0.5) parts.push(`Điểm buổi gần nhất (${lastScore.toFixed(1)}) cao hơn mức trung bình của lớp (${classAvg.toFixed(1)}).`);
      else if(classAvg - lastScore > 0.5) parts.push(`Điểm buổi gần nhất (${lastScore.toFixed(1)}) còn thấp hơn mức trung bình của lớp (${classAvg.toFixed(1)}), cần luyện tập thêm.`);
      else parts.push(`Điểm buổi gần nhất (${lastScore.toFixed(1)}) tương đương mức trung bình chung của lớp.`);
    }
  }

  if(lastSession){
    const allScores = students.map(s=>sessionScoreAvg(lastSession, s.id)).filter(v=>v!==null);
    if(allScores.length){
      const max = Math.max(...allScores), min = Math.min(...allScores);
      parts.push(`Buổi ${fmtDateVN(lastSession.date)}, điểm cao nhất của lớp là ${max.toFixed(1)}, thấp nhất là ${min.toFixed(1)}.`);
    }
  }

  const cl = studentChecklistStats(classId, studentId);
  if(cl.total>0){
    if(cl.rate>=90) parts.push(`Hoàn thành bài tập rất tốt (đạt ${cl.rate}%, trong đó có ${cl.partial} lượt làm chưa đầy đủ và ${cl.none} lượt chưa làm).`);
    else if(cl.rate>=70) parts.push(`Hoàn thành bài tập khá tốt (đạt ${cl.rate}%), tuy nhiên còn ${cl.partial} lượt làm thiếu và ${cl.none} lượt chưa làm bài.`);
    else parts.push(`Cần chú ý hơn về việc hoàn thành bài tập: chỉ đạt ${cl.rate}% (${cl.none} lượt chưa làm, ${cl.partial} lượt làm chưa đầy đủ trên tổng ${cl.total} lượt được giao).`);
  }

  return parts.join(' ');
}

function generateClassRemark(classId){
  const cls = getClass(classId);
  const students = cls.students;
  const sessions = getSessions(classId);
  if(!sessions.length || !students.length) return 'Chưa có đủ dữ liệu buổi học để nhận xét về lớp.';

  const rates = students.map(s=>studentAttendanceStats(classId,s.id).rate).filter(r=>r!==null);
  const avgRate = rates.length? Math.round(rates.reduce((a,b)=>a+b,0)/rates.length) : null;

  const perSession = sessions.map(s=>sessionClassAvg(s, students.map(x=>x.id))).filter(v=>v!==null);
  let trendText = '';
  if(perSession.length>=2){
    const diff = perSession[perSession.length-1]-perSession[0];
    if(diff>0.5) trendText = 'Điểm trung bình chung của lớp có xu hướng tăng dần qua các buổi.';
    else if(diff<-0.5) trendText = 'Điểm trung bình chung của lớp có xu hướng giảm dần, cần có biện pháp hỗ trợ thêm.';
    else trendText = 'Điểm trung bình chung của lớp khá ổn định qua các buổi.';
  }

  const warns = getWarnings(classId);
  const warnText = warns.length ? `Hiện có ${warns.length} lượt học sinh cần chú ý (vắng liên tiếp hoặc điểm giảm dần).` : 'Chưa có học sinh nào trong diện cần cảnh báo đặc biệt.';

  const attendText = avgRate!==null ? `Tỷ lệ chuyên cần trung bình của lớp đạt ${avgRate}%.` : '';

  const clRates = students.map(s=>studentChecklistStats(classId,s.id).rate).filter(r=>r!==null);
  const avgCl = clRates.length? Math.round(clRates.reduce((a,b)=>a+b,0)/clRates.length) : null;
  const lowClCount = students.filter(s=>{ const r = studentChecklistStats(classId,s.id).rate; return r!==null && r<60; }).length;
  let clText = '';
  if(avgCl!==null){
    clText = `Tỷ lệ hoàn thành bài tập trung bình của lớp đạt ${avgCl}%`;
    clText += lowClCount>0 ? `, trong đó có ${lowClCount} học sinh hoàn thành dưới 60% số bài được giao, cần được nhắc nhở thêm.` : '.';
  }

  // So sánh buổi gần nhất với buổi liền trước — nói rõ % chuyên cần thay đổi ra sao
  let compareText = '';
  if(sessions.length>=2){
    const studentIds = students.map(s=>s.id);
    const last = sessions[sessions.length-1], prev = sessions[sessions.length-2];
    const lastAtt = sessionAttendanceRate(last, studentIds);
    const prevAtt = sessionAttendanceRate(prev, studentIds);
    if(lastAtt!==null && prevAtt!==null){
      const d = lastAtt-prevAtt;
      if(d>0) compareText = `So với buổi trước (${fmtDateVN(prev.date)}), chuyên cần buổi gần nhất (${fmtDateVN(last.date)}) tăng ${d}%, từ ${prevAtt}% lên ${lastAtt}%.`;
      else if(d<0) compareText = `So với buổi trước (${fmtDateVN(prev.date)}), chuyên cần buổi gần nhất (${fmtDateVN(last.date)}) giảm ${Math.abs(d)}%, từ ${prevAtt}% xuống ${lastAtt}%.`;
      else compareText = `Chuyên cần buổi gần nhất (${fmtDateVN(last.date)}) giữ nguyên ở mức ${lastAtt}% so với buổi trước.`;
    }
  }

  return [attendText, compareText, trendText, clText, warnText].filter(Boolean).join(' ');
}

function trendArrow(d){ if(d===null||d===undefined) return ''; if(d>0) return '▲ '; if(d<0) return '▼ '; return '● '; }
function trendColor(d){ return d===null||d===undefined ? 'var(--ink-soft)' : (d>0 ? 'var(--success)' : (d<0 ? 'var(--danger)' : 'var(--ink-soft)')); }

function buildSessionInfographicPrompt(classId, date, scoreMode){
  const cls = getClass(classId);
  const session = (state.sessionsByClass[classId]||[]).find(s=>s.date===date);
  if(!cls || !session) return '';
  const students = cls.students;
  const types = session.exerciseTypes || [];
  const exercises = session.exercises || [];
  const hasNote = !!(session.generalNote && session.generalNote.trim());
  const showFull = scoreMode === 'full';

  const L = [];
  L.push('Bạn là trợ lý tạo INFOGRAPHIC BÁO CÁO TỔNG KẾT BUỔI HỌC gửi phụ huynh, dùng đúng số liệu dưới đây, không bịa thêm.');
  L.push('');
  L.push('=== DỮ LIỆU ===');
  L.push(`Lớp: ${cls.name} · Ngày: ${fmtDateVN(date)} · GV: ${state.teacherName || '(chưa nhập)'}`);
  L.push(`Nội dung bài học: ${session.content || '(chưa nhập)'}`);
  L.push(`BTVN giao: ${session.homework || '(chưa nhập)'}`);
  if(hasNote) L.push(`Lưu ý cho buổi học: ${session.generalNote.trim()}`);
  L.push('');

  const absentees = students.map(st=>({name:st.name, status:session.attendance[st.id]})).filter(x=>x.status==='absent'||x.status==='late');
  L.push('Điểm danh (chỉ ghi học sinh vắng/muộn, còn lại mặc định có mặt):');
  L.push(absentees.length ? absentees.map(x=>`${x.name} (${x.status==='absent'?'Vắng':'Muộn'})`).join(', ') : 'Cả lớp có mặt đầy đủ.');

  if(types.length){
    L.push('');
    L.push('BTVN còn thiếu (gộp theo đầu mục, tên HS liệt kê dưới mỗi mục — KHÔNG tính học sinh vắng mặt vào đây, vì vắng đã thể hiện ở mục điểm danh rồi):');
    let any = false;
    types.forEach(t=>{
      const names = students.filter(st=>{
        if(session.attendance[st.id]==='absent') return false;
        return ((session.checklist[st.id]||{})[t.id]||'none')!=='full';
      }).map(st=>st.name);
      if(names.length){ any=true; L.push(`${t.name}: ${names.join(', ')}`); }
    });
    if(!any) L.push('Cả lớp hoàn thành đầy đủ.');

    // Danh sách riêng: học sinh làm ĐỦ tất cả các loại bài (để khen ngợi), không tính học sinh vắng
    const doneFull = students.filter(st=>{
      if(session.attendance[st.id]==='absent') return false;
      return types.every(t=> ((session.checklist[st.id]||{})[t.id]||'none')==='full');
    }).map(st=>st.name);
    L.push('');
    L.push('Học sinh hoàn thành ĐỦ tất cả bài tập (để khen ngợi):');
    L.push(doneFull.length ? doneFull.join(', ') : '(Không có học sinh nào hoàn thành đủ tất cả các loại bài trong buổi này.)');
  }

  if(exercises.length){
    exercises.forEach(e=>{
      const scored = students.map(st=>({
        name: st.name,
        score: exerciseScoreOn10(e, (session.scores[st.id]||{})[e.id]),
      })).filter(x=>x.score!==null);
      const titleSuffix = exerciseMode(e)==='scale10' ? '(thang điểm 10)' : `(.../${exerciseTotal(e)} câu)`;
      L.push('');
      L.push(`Điểm "${e.name}" ${titleSuffix}:`);
      if(!scored.length){ L.push('Chưa có điểm.'); return; }

      if(showFull){
        L.push('Điểm đầy đủ của cả lớp (liệt kê TẤT CẢ học sinh):');
        L.push(scored.map(x=>`${x.name}: ${x.score.toFixed(1)}`).join(' · '));
      } else {
        // Chỉ hiện học sinh điểm cao (điểm >8, hoặc Top 5 cao nhất lớp — tính cả đồng điểm ở mốc thứ 5)
        const sortedDesc = scored.slice().sort((a,b)=>b.score-a.score);
        const top5CutoffScore = sortedDesc.length ? sortedDesc[Math.min(4, sortedDesc.length-1)].score : null;
        const topScorers = scored.filter(x=> x.score>8 || (top5CutoffScore!==null && x.score>=top5CutoffScore));

        L.push('Học sinh điểm cao (điểm >8 hoặc Top 5 cao nhất lớp) — chỉ liệt kê đúng những em này kèm điểm, các em khác không hiện tên/điểm:');
        L.push(topScorers.length ? topScorers.map(x=>`${x.name}: ${x.score.toFixed(1)}`).join(' · ') : '(Không có học sinh nào đạt mốc điểm cao cho bài này.)');
      }

      const max = Math.max(...scored.map(x=>x.score)), min = Math.min(...scored.map(x=>x.score));
      const avg = scored.reduce((a,b)=>a+b.score,0)/scored.length;
      const top = scored.filter(x=>x.score===max).map(x=>x.name).join(', ');
      L.push(showFull
        ? `Tổng kết: Cao nhất ${max.toFixed(1)} — HS đạt: ${top} · Thấp nhất ${min.toFixed(1)} · TB lớp ${avg.toFixed(1)}`
        : `Tổng kết (tính trên cả lớp, dùng để hiện số liệu chung, KHÔNG liệt kê thêm tên nào khác ngoài danh sách trên): Cao nhất ${max.toFixed(1)} — HS đạt: ${top} · Thấp nhất ${min.toFixed(1)} (không nêu tên) · TB lớp ${avg.toFixed(1)}`);
    });

    // Ghi chú: gộp 1 lần duy nhất cho cả buổi (không lặp lại theo từng bài luyện tập)
    const notedStudents = students.filter(st=>(session.studentNotes[st.id]||'').trim());
    L.push('');
    L.push('Ghi chú của giáo viên (CHỈ hiện 1 lần duy nhất — đặt trong 1 khung riêng ngay dưới toàn bộ phần kết quả điểm, KHÔNG lặp lại ghi chú theo từng bài luyện tập):');
    L.push(notedStudents.length ? notedStudents.map(st=>`${st.name} — ${session.studentNotes[st.id].trim()}`).join(' · ') : '(Không có học sinh nào có ghi chú riêng cho buổi này.)');
  }

  L.push('');
  L.push('=== YÊU CẦU THIẾT KẾ ===');
  L.push('Flat design hiện đại, dọc khổ A4, font Arial toàn bộ. Tông màu chủ đạo: XANH DƯƠNG, có hiệu ứng GRADIENT xuyên suốt toàn ảnh (không dùng màu xanh phẳng đơn sắc) — nền tổng thể là gradient xanh nhạt (từ #EAF1FF phía trên chuyển dần xuống #F7F9FC phía dưới); mỗi card/section cũng có điểm nhấn gradient xanh (VD dải màu mỏng phía trên card, khung icon nền gradient #3B5FE0→#2947C0, hoặc viền gradient nhẹ) thay vì icon/viền màu xanh phẳng 1 tông. Bố cục linh hoạt theo nội dung thật: mục ít thông tin (VD không ai vắng, không ai thiếu bài) thì thu gọn, không để trống lãng phí; mục nhiều thông tin thì đủ chỗ hiển thị, không ép chật — không chia đều diện tích cố định theo khung mẫu. Gói gọn trong 1 trang, padding vừa phải, bo góc 12-16px, bóng đổ mềm.');
  L.push('');
  L.push('HEADER: nền gradient xanh dương đậm (#3B5FE0→#2947C0), tiêu đề "BÁO CÁO TỔNG KẾT BUỔI HỌC" hoa đậm trắng. Dòng phụ: icon sách + "Môn học: Tiếng Anh", icon GV + tên GV. Góc phải: badge tròn trắng icon lịch + ngày.');
  L.push('SECTION 1 "NỘI DUNG BÀI HỌC": card trắng bo góc, dải/icon nhấn gradient xanh, danh sách gạch đầu dòng, từ khóa in đậm.');
  if(hasNote) L.push('SECTION "LƯU Ý BUỔI HỌC" (chỉ thêm mục này vì có nội dung): card trắng nhỏ gọn, icon 📌 nền gradient xanh, danh sách gạch đầu dòng ngắn.');
  L.push('SECTION "NỀN NẾP & Ý THỨC" / "BÀI TẬP VỀ NHÀ": 2 cột song song, chiều cao mỗi cột co giãn tự do theo nội dung (không cố định bằng nhau). Cột trái: icon mặt trời nền gradient xanh, chỉ liệt kê HS vắng/muộn dạng pill (đỏ nhạt "Vắng", cam "Muộn"); trống thì hiện "Cả lớp có mặt đầy đủ 🎉". Cột phải: icon cây bút nền gradient xanh, gồm 2 phần rõ rệt — (1) "Còn thiếu": trình bày theo từng đầu mục loại bài thiếu (tên loại bài làm tiêu đề nhỏ đậm), tên HS thiếu bài đó xếp thành pill cam ngay dưới, trống thì bỏ qua phần này; (2) ngay bên dưới, tiêu đề nhỏ "✅ Hoàn thành đầy đủ" — liệt kê tên các học sinh làm đủ tất cả bài (dạng pill xanh lá nhạt), lấy đúng danh sách "Học sinh hoàn thành ĐỦ tất cả bài tập" ở phần DỮ LIỆU; nếu rỗng thì bỏ qua phần này.');
  if(showFull){
    L.push('SECTION "KẾT QUẢ BÀI KIỂM TRA/LUYỆN TẬP": icon bia bắn. Với mỗi đầu điểm: 1 bảng đầy đủ 2 cột "Họ và tên" | "Điểm" liệt kê TẤT CẢ học sinh trong lớp, TẤT CẢ điểm cùng 1 màu xanh dương đậm #2947C0 (không phân cấp màu theo mức điểm). Dưới mỗi bảng điểm có 3 badge nhỏ nền gradient xanh nhạt (VD #EAF1FF→#DCE8FF): "🏆 Cao nhất: [điểm] — [tên]", "📉 Thấp nhất: [điểm] — [tên]", "📊 TB lớp: [điểm]" (chữ điểm giữ màu xanh dương đậm #2947C0 phẳng để dễ đọc, chỉ nền badge là gradient). Nhiều đầu điểm thì xếp thành các khối liền nhau. SAU CÙNG — khi đã hết toàn bộ các đầu điểm, thêm 1 khung riêng biệt DUY NHẤT (không lặp lại theo từng bài), nền nhạt khác màu để phân biệt, tiêu đề nhỏ "📝 Ghi chú của giáo viên", nội dung lấy đúng từ dòng "Ghi chú của giáo viên" ở phần DỮ LIỆU; nếu rỗng thì bỏ qua cả khung này.');
  } else {
    L.push('SECTION "KẾT QUẢ BÀI KIỂM TRA/LUYỆN TẬP": icon bia bắn. Ngay dưới tiêu đề section, thêm 1 dòng phụ đề nhỏ, chữ nghiêng, màu xám xanh nhạt: "Cô đính kèm một số bài đạt điểm tốt trong lớp". QUAN TRỌNG — vì lý do bảo mật điểm số của trung tâm, KHÔNG được liệt kê điểm của toàn bộ học sinh, chỉ hiển thị đúng danh sách học sinh điểm cao đã cho trong phần DỮ LIỆU. Với mỗi đầu điểm: 1 bảng gọn 2 cột "Họ và tên" | "Điểm", TẤT CẢ điểm cùng 1 màu xanh dương đậm #2947C0 (không phân cấp màu theo mức điểm); nếu danh sách rỗng thì bỏ qua bảng đó, chỉ hiện phần tổng kết. Dưới mỗi bảng điểm có 3 badge nhỏ nền gradient xanh nhạt (VD #EAF1FF→#DCE8FF): "🏆 Cao nhất: [điểm] — [tên học sinh đạt điểm đó]" (BẮT BUỘC ghi tên, lấy đúng tên trong phần DỮ LIỆU), "📉 Thấp nhất: [điểm]" (CHỈ ghi điểm số, TUYỆT ĐỐI KHÔNG ghi tên học sinh nào ở badge này), "📊 TB lớp: [điểm]" (chữ điểm giữ màu xanh dương đậm #2947C0 phẳng để dễ đọc, chỉ nền badge là gradient). Nhiều đầu điểm thì xếp thành các khối liền nhau. SAU CÙNG — khi đã hết toàn bộ các đầu điểm, thêm 1 khung riêng biệt DUY NHẤT (không lặp lại theo từng bài), nền nhạt khác màu để phân biệt, tiêu đề nhỏ "📝 Ghi chú của giáo viên", nội dung lấy đúng từ dòng "Ghi chú của giáo viên" ở phần DỮ LIỆU; nếu rỗng thì bỏ qua cả khung này. TUYỆT ĐỐI KHÔNG tự thêm tên/điểm của học sinh nào ngoài danh sách đã cho, kể cả khi biết điểm của họ qua phần tổng kết.');
  }
  L.push('FOOTER: chữ in nghiêng, canh giữa, xám nhạt: "Trân trọng cảm ơn Quý phụ huynh đã đồng hành cùng lớp học!"');
  L.push('');
  L.push('Dùng đúng số liệu ở phần DỮ LIỆU (tên, điểm, điểm danh, mức hoàn thành bài) để điền vào đúng mục tương ứng, toàn bộ tiếng Việt có dấu, không lỗi chính tả.');
  return L.join('\n');
}

function renderClassReportBody(classId){
  const cls = getClass(classId);
  const students = cls.students;
  const studentIds = students.map(s=>s.id);
  const sessions = getSessions(classId);
  const perSession = sessions.map(s=>({date:s.date, avg: sessionClassAvg(s, studentIds)})).filter(x=>x.avg!==null);
  const rates = students.map(s=>studentAttendanceStats(classId,s.id).rate).filter(r=>r!==null);
  const avgRate = rates.length? Math.round(rates.reduce((a,b)=>a+b,0)/rates.length) : null;
  const allAvgs = students.map(s=>{
    const series = studentScoreSeries(classId, s.id);
    return series.length? series.reduce((a,b)=>a+b.score,0)/series.length : null;
  });
  const validAvgs = allAvgs.filter(v=>v!==null);
  const classAvg = validAvgs.length? validAvgs.reduce((a,b)=>a+b,0)/validAvgs.length : null;
  const warns = getWarnings(classId);
  const warnMap = {}; warns.forEach(w=>{ warnMap[w.studentId] = warnMap[w.studentId]? warnMap[w.studentId]+', '+ (w.type==='absence'?'vắng liên tiếp':'điểm giảm dần') : (w.type==='absence'?'vắng liên tiếp':'điểm giảm dần'); });
  const checklistStats = students.map(s=>studentChecklistStats(classId, s.id));
  const validCl = checklistStats.filter(c=>c.rate!==null);
  const avgChecklist = validCl.length? Math.round(validCl.reduce((a,b)=>a+b.rate,0)/validCl.length) : null;

  const chartSvg = perSession.length ? lineChartSVG(perSession.map(p=>fmtDateVN(p.date)), [{name:'Trung bình lớp', color:'var(--accent-deep)', values:perSession.map(p=>p.avg)}]) : `<div class="muted">Chưa có dữ liệu điểm để vẽ biểu đồ.</div>`;

  // Bảng lịch sử: mỗi buổi so với đúng buổi liền trước nó (mới nhất lên đầu)
  const historyRows = sessions.map((s,i)=>{
    const prev = i>0 ? sessions[i-1] : null;
    const avg = sessionClassAvg(s, studentIds);
    const prevAvg = prev ? sessionClassAvg(prev, studentIds) : null;
    const att = sessionAttendanceRate(s, studentIds);
    const prevAtt = prev ? sessionAttendanceRate(prev, studentIds) : null;
    const hw = sessionChecklistRate(s, studentIds);
    const prevHw = prev ? sessionChecklistRate(prev, studentIds) : null;
    return {
      date: s.date,
      avg, dAvg: (avg!==null && prevAvg!==null) ? avg-prevAvg : null,
      att, dAtt: (att!==null && prevAtt!==null) ? att-prevAtt : null,
      hw, dHw: (hw!==null && prevHw!==null) ? hw-prevHw : null,
    };
  }).reverse();
  const historyShown = historyRows.slice(0, 12);

  const lastRow = historyRows[0] || null;
  const prevRow = historyRows[1] || null;

  return `
    <div class="report-header">
      <div>
        <h2>Báo cáo tình hình học tập — Cả lớp</h2>
        <div class="muted">Lớp: ${esc(cls.name)} · Ngày xuất: ${fmtDateVN(todayISO())} · ${sessions.length} buổi học đã ghi nhận</div>
      </div>
    </div>

    <div class="grid-4" style="margin-bottom:18px;">
      <div class="stat-box"><div class="stat-num">${students.length}</div><div class="stat-label">Học sinh</div></div>
      <div class="stat-box"><div class="stat-num">${avgRate!==null? avgRate+'%':'—'}</div><div class="stat-label">Chuyên cần TB lớp (toàn bộ)</div></div>
      <div class="stat-box"><div class="stat-num">${classAvg!==null? classAvg.toFixed(1):'—'}</div><div class="stat-label">Điểm TB lớp (toàn bộ)</div></div>
      <div class="stat-box"><div class="stat-num">${avgChecklist!==null? avgChecklist+'%':'—'}</div><div class="stat-label">Hoàn thành BT TB lớp (toàn bộ)</div></div>
    </div>

    ${lastRow ? `
    <h3 style="font-size:16.5px;margin-bottom:10px;">🔍 Buổi gần nhất (${fmtDateVN(lastRow.date)}) so với buổi trước${prevRow? ' ('+fmtDateVN(prevRow.date)+')' : ''}</h3>
    <table style="margin-bottom:22px;">
      <thead><tr><th>Chỉ số</th><th style="text-align:center;">Buổi trước</th><th style="text-align:center;">Buổi này</th><th style="text-align:center;">Thay đổi</th></tr></thead>
      <tbody>
        <tr class="ledger">
          <td>Điểm trung bình lớp</td>
          <td class="mono" style="text-align:center;">${prevRow && prevRow.avg!==null? prevRow.avg.toFixed(1) : '—'}</td>
          <td class="mono" style="text-align:center;font-weight:700;">${lastRow.avg!==null? lastRow.avg.toFixed(1) : '—'}</td>
          <td class="mono" style="text-align:center;color:${trendColor(lastRow.dAvg)};">${trendArrow(lastRow.dAvg)}${lastRow.dAvg!==null? (lastRow.dAvg>=0?'+':'')+lastRow.dAvg.toFixed(1) : '—'}</td>
        </tr>
        <tr class="ledger">
          <td>Tỷ lệ chuyên cần</td>
          <td class="mono" style="text-align:center;">${prevRow && prevRow.att!==null? prevRow.att+'%' : '—'}</td>
          <td class="mono" style="text-align:center;font-weight:700;">${lastRow.att!==null? lastRow.att+'%' : '—'}</td>
          <td class="mono" style="text-align:center;color:${trendColor(lastRow.dAtt)};">${trendArrow(lastRow.dAtt)}${lastRow.dAtt!==null? (lastRow.dAtt>=0?'+':'')+lastRow.dAtt+'%' : '—'}</td>
        </tr>
        <tr class="ledger">
          <td>Tỷ lệ hoàn thành bài tập</td>
          <td class="mono" style="text-align:center;">${prevRow && prevRow.hw!==null? prevRow.hw+'%' : '—'}</td>
          <td class="mono" style="text-align:center;font-weight:700;">${lastRow.hw!==null? lastRow.hw+'%' : '—'}</td>
          <td class="mono" style="text-align:center;color:${trendColor(lastRow.dHw)};">${trendArrow(lastRow.dHw)}${lastRow.dHw!==null? (lastRow.dHw>=0?'+':'')+lastRow.dHw+'%' : '—'}</td>
        </tr>
      </tbody>
    </table>` : ''}

    <h3 style="font-size:16.5px;margin-bottom:10px;">📈 Biến động qua từng buổi ${historyRows.length>12? '<span class="tiny">(12 buổi gần nhất)</span>':''}</h3>
    <table style="margin-bottom:22px;">
      <thead><tr><th>Ngày</th><th style="text-align:center;">Điểm TB</th><th style="text-align:center;">Δ điểm</th><th style="text-align:center;">Chuyên cần</th><th style="text-align:center;">Δ chuyên cần</th><th style="text-align:center;">Hoàn thành BT</th><th style="text-align:center;">Δ BT</th></tr></thead>
      <tbody>
      ${historyShown.map(r=>`
        <tr class="ledger">
          <td>${fmtDateVN(r.date)}</td>
          <td class="mono" style="text-align:center;">${r.avg!==null? r.avg.toFixed(1) : '—'}</td>
          <td class="mono" style="text-align:center;color:${trendColor(r.dAvg)};">${r.dAvg!==null? trendArrow(r.dAvg)+(r.dAvg>=0?'+':'')+r.dAvg.toFixed(1) : '—'}</td>
          <td class="mono" style="text-align:center;">${r.att!==null? r.att+'%' : '—'}</td>
          <td class="mono" style="text-align:center;color:${trendColor(r.dAtt)};">${r.dAtt!==null? trendArrow(r.dAtt)+(r.dAtt>=0?'+':'')+r.dAtt+'%' : '—'}</td>
          <td class="mono" style="text-align:center;">${r.hw!==null? r.hw+'%' : '—'}</td>
          <td class="mono" style="text-align:center;color:${trendColor(r.dHw)};">${r.dHw!==null? trendArrow(r.dHw)+(r.dHw>=0?'+':'')+r.dHw+'%' : '—'}</td>
        </tr>`).join('')}
      </tbody>
    </table>

    <h3 style="font-size:16.5px;margin-bottom:10px;">Diễn biến điểm trung bình của lớp</h3>
    <div style="margin-bottom:18px;">${chartSvg}</div>

    ${validAvgs.length ? (() => {
      const distBuckets = [
        {label:'Giỏi (≥8)', value:0, color:'var(--success)'},
        {label:'Khá (6.5–7.9)', value:0, color:'var(--accent-deep)'},
        {label:'Trung bình (5–6.4)', value:0, color:'var(--late)'},
        {label:'Yếu (<5)', value:0, color:'var(--danger)'},
      ];
      validAvgs.forEach(v=>{
        if(v>=8) distBuckets[0].value++;
        else if(v>=6.5) distBuckets[1].value++;
        else if(v>=5) distBuckets[2].value++;
        else distBuckets[3].value++;
      });
      return `<h3 style="font-size:16.5px;margin-bottom:10px;">🥧 Phân bố học lực theo điểm trung bình</h3>
      <div style="margin-bottom:18px;">${pieChartWithLegend(distBuckets)}</div>`;
    })() : ''}

    <h3 style="font-size:16.5px;margin-bottom:10px;">Tổng hợp theo học sinh (toàn bộ)</h3>
    <table style="margin-bottom:18px;"><thead><tr><th>Học sinh</th><th>Chuyên cần</th><th>Điểm TB</th><th>So với TB lớp</th><th>Hoàn thành BT</th><th>Ghi chú</th></tr></thead><tbody>
    ${students.map((s,i)=>{
      const att = studentAttendanceStats(classId, s.id);
      const series = studentScoreSeries(classId, s.id);
      const avg = series.length? series.reduce((a,b)=>a+b.score,0)/series.length : null;
      const diff = (avg!==null && classAvg!==null) ? avg-classAvg : null;
      const cl = checklistStats[i];
      return `<tr class="ledger ${warnMap[s.id]?'flagged':''}">
        <td>${esc(s.name)}</td>
        <td class="mono">${att.rate!==null?att.rate+'%':'—'}</td>
        <td class="mono">${avg!==null?avg.toFixed(1):'—'}</td>
        <td class="mono">${diff!==null? (diff>=0?'+':'')+diff.toFixed(1) : '—'}</td>
        <td class="mono">${cl.rate!==null?cl.rate+'%':'—'}</td>
        <td class="note-text">${esc(warnMap[s.id]||'')}</td>
      </tr>`;
    }).join('')}
    </tbody></table>

    <h3 style="font-size:16.5px;margin:18px 0 10px;">Nhận xét chung</h3>
    <div class="remark-box">${esc(generateClassRemark(classId))}</div>
  `;
}

function renderReport(){
  if(!state.classes.length) return `<div class="topbar"><h1 class="page-title">Báo cáo</h1></div><div class="card empty"><h3>Chưa có lớp học</h3></div>`;
  const classId = state.report.classId || state.currentClassId;
  const students = getStudents(classId);
  const mode = state.report.mode || 'student';
  const studentId = state.report.studentId || (students[0] && students[0].id);

  const classOptions = state.classes.map(c=>`<option value="${c.id}" ${c.id===classId?'selected':''}>${esc(c.name)}</option>`).join('');
  const studentOptions = students.map(s=>`<option value="${s.id}" ${s.id===studentId?'selected':''}>${esc(s.name)}</option>`).join('');

  const modeToggle = `<div class="tabs-sub no-print">
    <button class="${mode==='student'?'on':''}" data-action="report-set-mode" data-mode="student">Theo học sinh</button>
    <button class="${mode==='class'?'on':''}" data-action="report-set-mode" data-mode="class">Cả lớp</button>
  </div>`;

  const cls = getClass(classId);

  if(mode==='class'){
    const sessionsForInfo = getSessions(classId);
    const infoDate = (state.report.infographicDate && sessionsForInfo.some(s=>s.date===state.report.infographicDate))
      ? state.report.infographicDate
      : (sessionsForInfo.length ? sessionsForInfo[sessionsForInfo.length-1].date : null);
    const infoScoreMode = state.report.infographicScoreMode || 'top';
    return `
      <div class="topbar no-print">
        <div><h1 class="page-title">Báo cáo học tập</h1>${chalkUnderline()}<div class="page-sub">Tổng hợp tình hình học tập chung của cả lớp</div></div>
        <div style="display:flex; gap:8px;">
          <button class="btn btn-accent" data-action="export-doc">⬇ Xuất Word</button>
        </div>
      </div>
      ${modeToggle}
      <div class="card no-print" style="display:flex; gap:16px; flex-wrap:wrap;">
        <div><label class="field-label">Lớp</label><select class="class-select" data-action="report-change-class">${classOptions}</select></div>
      </div>
      <div class="card" id="report-print-area">
        ${cls.students.length ? renderClassReportBody(classId) : `<div class="empty"><h3>Lớp chưa có học sinh</h3></div>`}
      </div>

      ${sessionsForInfo.length ? `
      <div class="card no-print">
        <div class="card-title">🎨 Infographic tổng kết buổi học</div>
        <div class="muted" style="margin-bottom:10px;">Chọn 1 buổi học đã ghi nhận, tạo prompt kèm đúng dữ liệu buổi đó — dán vào ChatGPT (bản tạo ảnh) để ra ngay ảnh infographic gửi phụ huynh.</div>
        <div style="display:flex; gap:8px; align-items:flex-end; flex-wrap:wrap;">
          <div style="flex:1; min-width:200px;">
            <label class="field-label">Buổi học</label>
            <select data-action="report-change-infographic-date">
              ${sessionsForInfo.slice().reverse().map(s=>`<option value="${s.date}" ${infoDate===s.date?'selected':''}>${fmtDateVN(s.date)}</option>`).join('')}
            </select>
          </div>
          <div style="flex:1; min-width:220px;">
            <label class="field-label">Hiển thị điểm</label>
            <select data-action="report-change-infographic-score-mode">
              <option value="top" ${infoScoreMode==='top'?'selected':''}>Chỉ điểm nổi bật (ẩn bớt — cho trung tâm)</option>
              <option value="full" ${infoScoreMode==='full'?'selected':''}>Đầy đủ điểm cả lớp</option>
            </select>
          </div>
          <button class="btn btn-accent" data-action="generate-session-infographic-prompt" data-class="${classId}" data-date="${infoDate}" data-score-mode="${infoScoreMode}">✨ Tạo prompt infographic</button>
        </div>
        <div class="tiny" style="margin-top:8px;">"Chỉ điểm nổi bật" = chỉ hiện tên học sinh điểm >8/Top 5/có ghi chú riêng (dùng cho lớp không muốn công khai hết điểm). "Đầy đủ điểm" = liệt kê điểm mọi học sinh trong lớp.</div>
      </div>
      ${state.report.infographicPrompt ? `
      <div class="card no-print">
        <div class="card-title">
          <span>📝 Prompt infographic</span>
          <button class="btn btn-outline btn-sm" data-action="copy-session-infographic-prompt">💬 Copy prompt</button>
        </div>
        <textarea id="session-infographic-prompt-text" rows="16">${esc(state.report.infographicPrompt)}</textarea>
      </div>` : ''}
      ` : ''}
    `;
  }

  if(!students.length){
    return `<div class="topbar"><h1 class="page-title">Báo cáo</h1>${chalkUnderline()}</div>
    ${modeToggle}
    <div class="card no-print"><select class="class-select" data-action="report-change-class">${classOptions}</select></div>
    <div class="card empty"><h3>Lớp chưa có học sinh</h3></div>`;
  }

  const st = cls.students.find(s=>s.id===studentId);
  const remark = generateRemark(classId, studentId);
  const allSessions = getSessions(classId);
  const attLabel = (s) => s==='present'?'Có mặt': s==='absent'?'Vắng': s==='late'?'Muộn':'—';

  return `
    <div class="topbar no-print">
      <div><h1 class="page-title">Báo cáo học tập</h1>${chalkUnderline()}<div class="page-sub">Chọn lớp và học sinh để xem báo cáo gửi phụ huynh</div></div>
      <div style="display:flex; gap:8px;">
        <button class="btn btn-outline" data-action="copy-zalo" data-class="${classId}" data-student="${studentId}">💬 Copy tin nhắn Zalo</button>
        <button class="btn btn-accent" data-action="export-doc">⬇ Xuất Word</button>
      </div>
    </div>
    ${modeToggle}
    <div class="card no-print" style="display:flex; gap:16px; flex-wrap:wrap;">
      <div><label class="field-label">Lớp</label><select class="class-select" data-action="report-change-class">${classOptions}</select></div>
      <div><label class="field-label">Học sinh</label><select class="class-select" data-action="report-change-student">${studentOptions}</select></div>
    </div>

    <div class="card" id="report-print-area">
      <div class="report-header">
        <div>
          <h2>Báo cáo học tập — ${esc(st.name)}</h2>
          <div class="muted">Lớp: ${esc(cls.name)} · Ngày xuất: ${fmtDateVN(todayISO())}</div>
        </div>
      </div>

      ${(() => {
        const attStats = studentAttendanceStats(classId, studentId);
        const clStats = studentChecklistStats(classId, studentId);
        if(!attStats.total && !clStats.total) return '';
        const attSub = attStats.total ? `Có mặt ${attStats.present} · Vắng ${attStats.absent} · Muộn ${attStats.late}` : '';
        const clSub = clStats.total ? `Đầy đủ ${clStats.full} · Một phần ${clStats.partial} · Chưa làm ${clStats.none}` : '';
        const attColor = attStats.rate===null ? 'var(--accent)' : attStats.rate>=80 ? 'var(--success)' : attStats.rate>=50 ? 'var(--late)' : 'var(--danger)';
        const clColor = clStats.rate===null ? 'var(--accent)' : clStats.rate>=80 ? 'var(--success)' : clStats.rate>=50 ? 'var(--late)' : 'var(--danger)';
        return `<div style="display:flex; gap:28px; flex-wrap:wrap; margin-bottom:20px;">
          <div style="flex:1; min-width:220px; display:flex; align-items:center; gap:16px;">
            ${attStats.total ? progressRingSVG(attStats.rate, {color: attColor, centerSub:'Chuyên cần'}) : progressRingSVG(0, {centerMain:'—', centerSub:'Chuyên cần'})}
            <div>
              <h3 style="font-size:15px;margin-bottom:6px;">📅 Chuyên cần</h3>
              <div class="muted" style="font-size:13.5px;">${attSub || 'Chưa có dữ liệu điểm danh.'}</div>
            </div>
          </div>
          <div style="flex:1; min-width:220px; display:flex; align-items:center; gap:16px;">
            ${clStats.total ? progressRingSVG(clStats.rate, {color: clColor, centerSub:'Hoàn thành BT'}) : progressRingSVG(0, {centerMain:'—', centerSub:'Hoàn thành BT'})}
            <div>
              <h3 style="font-size:15px;margin-bottom:6px;">📝 Hoàn thành bài tập</h3>
              <div class="muted" style="font-size:13.5px;">${clSub || 'Chưa có dữ liệu bài tập.'}</div>
            </div>
          </div>
        </div>`;
      })()}

      ${(() => {
        const recent = studentRecentItems(classId, studentId, 8);
        if(!recent.length) return '';
        return `<h3 style="font-size:16.5px;margin-bottom:10px;">🗂️ Danh sách bài kiểm tra & bài tập gần đây</h3>
        <div style="overflow-x:auto;margin-bottom:22px;">
        <table>
          <thead><tr><th style="width:95px;">Ngày</th><th style="width:220px;max-width:220px;">Tên bài</th><th style="width:130px;">Loại</th><th style="width:80px;text-align:center;">Điểm</th><th style="width:150px;">Trạng thái</th></tr></thead>
          <tbody>
          ${recent.map(it=>`<tr class="ledger">
            <td class="mono">${fmtDateVN(it.date)}</td>
            <td class="note-text" style="max-width:220px;word-break:break-word;">${esc(it.name)}</td>
            <td>${esc(it.type)}</td>
            <td class="mono" style="text-align:center;">${esc(it.scoreText)}</td>
            <td>${esc(it.statusText)}</td>
          </tr>`).join('')}
          </tbody>
        </table>
        </div>`;
      })()}

      ${allSessions.length ? `
      <div style="overflow-x:auto;">
      <table style="min-width:840px;">
        <thead><tr>
          <th style="width:40px;text-align:center;">Stt</th>
          <th style="width:95px;">Ngày</th>
          <th>Nội dung học</th>
          <th>BTVN</th>
          <th style="width:75px;text-align:center;">Điểm TB</th>
          <th style="width:90px;text-align:center;">Điểm danh</th>
          <th>Nhận xét / Ghi chú</th>
          <th class="no-print" style="width:70px;text-align:center;">Chỉnh sửa</th>
        </tr></thead>
        <tbody>
        ${allSessions.map((s,i)=>{
          const attStatus = s.attendance[studentId] || null;
          const attLabel = attStatus==='present'?'Có mặt': attStatus==='absent'?'Vắng': attStatus==='late'?'Muộn':'—';
          const attColor = attStatus==='present'?'var(--success)': attStatus==='absent'?'var(--danger)': attStatus==='late'?'var(--late)':'var(--ink-soft)';
          const scoreAvg = sessionScoreAvg(s, studentId);
          // Gộp ghi chú riêng của em + nhận xét nền nếp chung của buổi (2 ô "Ghi chú" trong tab Buổi học)
          const noteParts = [];
          if(s.studentNotes[studentId]) noteParts.push(s.studentNotes[studentId]);
          if(s.disciplineNote) noteParts.push(s.disciplineNote);
          const note = noteParts.join(' — ');
          return `<tr class="ledger">
            <td class="mono" style="text-align:center;">${i+1}</td>
            <td class="mono">${fmtDateVN(s.date)}</td>
            <td class="note-text">${esc(s.content||'—')}</td>
            <td class="note-text">${esc(s.homework||'—')}</td>
            <td class="mono" style="text-align:center;">${scoreAvg!==null? scoreAvg.toFixed(1) : '—'}</td>
            <td class="mono" style="text-align:center;color:${attColor};font-weight:700;">${attLabel}</td>
            <td class="note-text">${esc(note||'—')}</td>
            <td class="no-print" style="text-align:center;"><button class="btn btn-outline btn-sm" data-action="goto-session-date" data-class="${classId}" data-date="${s.date}">✎ Sửa</button></td>
          </tr>`;
        }).join('')}
        </tbody>
      </table>
      </div>
      ` : `<div class="muted">Chưa có buổi học nào được ghi nhận cho lớp này.</div>`}

      <h3 style="font-size:16.5px;margin:18px 0 10px;">Nhận xét</h3>
      <div class="remark-box">${esc(remark)}</div>
    </div>
  `;
}

/* ============================================================
   PROGRESS
============================================================ */
function renderProgress(){
  if(!state.classes.length) return `<div class="topbar"><h1 class="page-title">Tiến độ học tập</h1></div><div class="card empty"><h3>Chưa có lớp học</h3></div>`;

  const q = state.progress.query || '';
  let results = [];
  if(q.trim()){
    const ql = q.toLowerCase();
    state.classes.forEach(c=>{
      c.students.forEach(s=>{
        const hay = (c.name+' '+s.name).toLowerCase();
        if(hay.includes(ql)) results.push({classId:c.id, className:c.name, studentId:s.id, studentName:s.name});
      });
    });
  }

  let detail = '';
  if(state.progress.classId && state.progress.studentId){
    const classId = state.progress.classId, studentId = state.progress.studentId;
    const cls = getClass(classId);
    const st = cls && cls.students.find(s=>s.id===studentId);
    if(st){
      const series = studentScoreSeries(classId, studentId);
      const att = studentAttendanceStats(classId, studentId);
      const chartSvg = series.length ? lineChartSVG(
        series.map(s=>fmtDateVN(s.date)),
        [
          {name:esc(st.name), color:'var(--accent-deep)', values: series.map(s=>s.score)},
          {name:'Trung bình lớp', color:'var(--ink-faint)', dash:'5,4', values: series.map(s=>s.classAvg)},
        ]
      ) : `<div class="muted">Chưa có dữ liệu điểm.</div>`;

      detail = `
        <div class="card">
          <div class="card-title">${esc(cls.name)} — ${esc(st.name)}
            <button class="btn btn-outline btn-sm" data-action="progress-to-report" data-class="${classId}" data-student="${studentId}">Xem báo cáo đầy đủ →</button>
          </div>
          <div class="grid-3" style="margin-bottom:16px;">
            <div class="stat-box"><div class="stat-num">${att.rate!==null?att.rate+'%':'—'}</div><div class="stat-label">Chuyên cần</div></div>
            <div class="stat-box"><div class="stat-num">${series.length? (series.reduce((a,b)=>a+b.score,0)/series.length).toFixed(1) :'—'}</div><div class="stat-label">Điểm TB</div></div>
            <div class="stat-box"><div class="stat-num">${series.length}</div><div class="stat-label">Buổi có điểm</div></div>
          </div>
          ${chartSvg}
          <div class="legend"><span><i style="background:var(--accent-deep);"></i>${esc(st.name)}</span><span><i style="background:var(--ink-faint);"></i>Trung bình lớp</span></div>
          <table style="margin-top:16px;"><thead><tr><th>Buổi</th><th>Điểm TB</th><th>Ghi chú</th></tr></thead><tbody>
          ${getSessions(classId).map(s=>{
            const sc = sessionScoreAvg(s, studentId);
            const note = s.studentNotes[studentId];
            if(sc===null && !note) return '';
            return `<tr class="ledger"><td>${fmtDateVN(s.date)}</td><td class="mono">${sc!==null?sc.toFixed(1):'—'}</td><td class="note-text">${esc(note||'')}</td></tr>`;
          }).join('')}
          </tbody></table>
        </div>`;
    }
  } else if(state.progress.classId){
    const classId = state.progress.classId;
    const cls = getClass(classId);
    const sessions = getSessions(classId);
    const students = cls.students;
    const perSession = sessions.map(s=>({date:s.date, avg: sessionClassAvg(s, students.map(x=>x.id))})).filter(x=>x.avg!==null);
    const chartSvg = perSession.length ? lineChartSVG(perSession.map(p=>fmtDateVN(p.date)), [{name:'Trung bình lớp', color:'var(--accent-deep)', values:perSession.map(p=>p.avg)}]) : `<div class="muted">Chưa có dữ liệu điểm.</div>`;
    detail = `
      <div class="card">
        <div class="card-title">Tổng quan lớp — ${esc(cls.name)}</div>
        ${chartSvg}
        <table style="margin-top:16px;"><thead><tr><th>Học sinh</th><th>Chuyên cần</th><th>Điểm TB</th></tr></thead><tbody>
        ${students.map(s=>{
          const att = studentAttendanceStats(classId, s.id);
          const series = studentScoreSeries(classId, s.id);
          const avg = series.length? series.reduce((a,b)=>a+b.score,0)/series.length : null;
          return `<tr class="ledger" style="cursor:pointer;" data-action="progress-pick" data-class="${classId}" data-student="${s.id}">
            <td>${esc(s.name)}</td><td class="mono">${att.rate!==null?att.rate+'%':'—'}</td><td class="mono">${avg!==null?avg.toFixed(1):'—'}</td>
          </tr>`;
        }).join('')}
        </tbody></table>
      </div>`;
  }

  return `
    <div class="topbar">
      <div><h1 class="page-title">Tiến độ học tập</h1>${chalkUnderline()}<div class="page-sub">Gõ "lớp - tên học sinh" để tra cứu nhanh khi phụ huynh hỏi</div></div>
    </div>
    <div class="card">
      <div class="search-box">
        <input type="text" placeholder="Tìm theo tên lớp hoặc tên học sinh..." value="${esc(q)}" data-action="progress-search">
        ${results.length? `<div class="search-results">
          ${results.slice(0,20).map(r=>`<div class="search-result-item" data-action="progress-select" data-class="${r.classId}" data-student="${r.studentId}"><b>${esc(r.className)}</b> — ${esc(r.studentName)}</div>`).join('')}
        </div>` : ''}
      </div>
      <div class="chip-row" style="margin-top:14px;">
        ${state.classes.map(c=>`<div class="chip" style="cursor:pointer;background:${c.id===state.progress.classId && !state.progress.studentId ?'var(--accent)':'var(--accent-soft)'};color:${c.id===state.progress.classId && !state.progress.studentId?'#FFFFFF':'var(--accent-deep)'};" data-action="progress-class-overview" data-class="${c.id}">${esc(c.name)}</div>`).join('')}
      </div>
    </div>
    ${detail}
  `;
}

/* ============================================================
   SVG LINE CHART
============================================================ */
function resolveVar(v){
  if(typeof v==='string' && v.startsWith('var(')){
    const name = v.slice(4,-1).trim();
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#999';
  }
  return v;
}
function lineChartSVG(labels, series){
  const W = 760, H = 240, padL = 40, padR = 16, padT = 16, padB = 34;
  const allVals = [];
  series.forEach(s=> s.values.forEach(v=>{ if(v!==null && v!==undefined) allVals.push(v); }));
  if(!allVals.length) return `<div class="muted">Không đủ dữ liệu.</div>`;
  let min = Math.min(0, Math.min(...allVals));
  let max = Math.max(10, Math.max(...allVals));
  if(max===min) max = min+1;
  const n = labels.length;
  const x = i => padL + (n<=1? 0 : (i/(n-1))*(W-padL-padR));
  const y = v => H - padB - ((v-min)/(max-min))*(H-padT-padB);

  const gridLines = [];
  const steps = 4;
  for(let i=0;i<=steps;i++){
    const val = min + (max-min)*i/steps;
    const yy = y(val);
    gridLines.push(`<line x1="${padL}" x2="${W-padR}" y1="${yy}" y2="${yy}" stroke="#E4DCC9" stroke-width="1"/>`);
    gridLines.push(`<text x="${padL-8}" y="${yy+3}" font-size="10" fill="#9AA7AC" text-anchor="end" font-family="IBM Plex Mono, monospace">${val.toFixed(1)}</text>`);
  }
  const xLabels = labels.map((l,i)=>{
    if(n>8 && i%Math.ceil(n/8)!==0 && i!==n-1) return '';
    return `<text x="${x(i)}" y="${H-12}" font-size="10" fill="#9AA7AC" text-anchor="middle" font-family="Roboto, sans-serif">${l}</text>`;
  }).join('');

  const lines = series.map(s=>{
    const color = resolveVar(s.color);
    let d = '';
    let started = false;
    const pts = [];
    s.values.forEach((v,i)=>{
      if(v===null || v===undefined){ started=false; return; }
      const cmd = started? 'L':'M';
      d += `${cmd}${x(i).toFixed(1)},${y(v).toFixed(1)} `;
      started = true;
      pts.push(`<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3" fill="${color}"/>`);
    });
    const dashAttr = s.dash ? `stroke-dasharray="${s.dash}"` : '';
    return `<path d="${d}" fill="none" stroke="${color}" stroke-width="2.2" ${dashAttr} stroke-linecap="round" stroke-linejoin="round"/>` + pts.join('');
  }).join('');

  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;max-height:260px;">${gridLines.join('')}${lines}${xLabels}</svg>`;
}

function pieChartSVG(data){
  const size = 160, r = 70, cx = 80, cy = 80;
  const total = data.reduce((a,b)=>a+b.value,0);
  if(!total) return `<svg viewBox="0 0 ${size} ${size}" style="width:140px;height:140px;flex-shrink:0;"><circle cx="${cx}" cy="${cy}" r="${r}" fill="#EFEAE0"/></svg>`;
  const toRad = a => (a*Math.PI/180);
  let angle = -90;
  const parts = data.filter(d=>d.value>0).map(d=>{
    const frac = d.value/total;
    const startAngle = angle;
    const endAngle = angle + frac*360;
    angle = endAngle;
    const color = resolveVar(d.color);
    if(frac >= 0.9999){
      return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}"/>`;
    }
    const large = (endAngle-startAngle) > 180 ? 1 : 0;
    const x1 = cx + r*Math.cos(toRad(startAngle));
    const y1 = cy + r*Math.sin(toRad(startAngle));
    const x2 = cx + r*Math.cos(toRad(endAngle));
    const y2 = cy + r*Math.sin(toRad(endAngle));
    return `<path d="M${cx},${cy} L${x1.toFixed(2)},${y1.toFixed(2)} A${r},${r} 0 ${large} 1 ${x2.toFixed(2)},${y2.toFixed(2)} Z" fill="${color}" stroke="#fff" stroke-width="1.5"/>`;
  }).join('');
  return `<svg viewBox="0 0 ${size} ${size}" style="width:140px;height:140px;flex-shrink:0;">${parts}</svg>`;
}
function progressRingSVG(percent, opts){
  opts = opts || {};
  const size = opts.size || 132;
  const stroke = opts.stroke || 12;
  const color = resolveVar(opts.color || 'var(--accent)');
  const bg = '#EFEAE0';
  const r = (size - stroke)/2;
  const cx = size/2, cy = size/2;
  const circumference = 2*Math.PI*r;
  const pct = (percent===null || percent===undefined || isNaN(percent)) ? 0 : Math.max(0, Math.min(100, percent));
  const dash = circumference * pct/100;
  const mainText = opts.centerMain !== undefined ? opts.centerMain : `${Math.round(pct)}%`;
  const subText = opts.centerSub || '';
  return `<div style="position:relative;width:${size}px;height:${size}px;flex-shrink:0;">
    <svg viewBox="0 0 ${size} ${size}" style="width:${size}px;height:${size}px;transform:rotate(-90deg);">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${bg}" stroke-width="${stroke}"/>
      ${pct>0 ? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round" stroke-dasharray="${dash.toFixed(1)} ${circumference.toFixed(1)}"/>` : ''}
    </svg>
    <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;">
      <div style="font-size:${Math.round(size*0.19)}px;font-weight:800;color:var(--ink);line-height:1;">${esc(String(mainText))}</div>
      ${subText? `<div style="font-size:${Math.round(size*0.078)}px;color:var(--ink-soft);margin-top:4px;text-align:center;max-width:${size-20}px;">${esc(subText)}</div>` : ''}
    </div>
  </div>`;
}
function pieChartWithLegend(data){
  const total = data.reduce((a,b)=>a+b.value,0);
  const svg = pieChartSVG(data);
  const legend = data.map(d=>{
    const pct = total? Math.round(d.value/total*100) : 0;
    return `<div style="display:flex;align-items:center;gap:7px;margin-bottom:6px;">
      <span style="width:11px;height:11px;border-radius:3px;background:${resolveVar(d.color)};display:inline-block;flex-shrink:0;"></span>
      <span style="font-size:13.5px;">${esc(d.label)}: <strong>${d.value}</strong>${total? ` (${pct}%)` : ''}</span>
    </div>`;
  }).join('');
  return `<div style="display:flex; align-items:center; gap:18px; flex-wrap:wrap;">
    ${svg}
    <div>${legend}</div>
  </div>`;
}
/* ============================================================
   EXPORTS: WORD / EXCEL
============================================================ */
function buildZaloMessage(classId, studentId){
  const cls = getClass(classId);
  const st = cls && cls.students.find(s=>s.id===studentId);
  if(!st) return '';
  const att = studentAttendanceStats(classId, studentId);
  const series = studentScoreSeries(classId, studentId);
  const avgScore = series.length? (series.reduce((a,b)=>a+b.score,0)/series.length) : null;
  const cl = studentChecklistStats(classId, studentId);
  const remark = generateRemark(classId, studentId);

  const lines = [];
  lines.push(`📋 BÁO CÁO HỌC TẬP — ${st.name}`);
  lines.push(`Lớp: ${cls.name} · Ngày: ${fmtDateVN(todayISO())}`);
  lines.push('');
  lines.push(`✅ Chuyên cần: ${att.rate!==null? att.rate+'%':'chưa có dữ liệu'} (có mặt ${att.present}, vắng ${att.absent}, muộn ${att.late})`);
  lines.push(`📊 Điểm trung bình: ${avgScore!==null? avgScore.toFixed(1)+'/10':'chưa có dữ liệu'}`);
  lines.push(`📝 Hoàn thành bài tập: ${cl.rate!==null? cl.rate+'%':'chưa có dữ liệu'}`);
  lines.push('');
  lines.push(`Nhận xét: ${remark || 'Chưa có đủ dữ liệu để nhận xét.'}`);
  lines.push('');
  lines.push('— Gửi từ giáo viên chủ nhiệm');
  return lines.join('\n');
}

function copyTextToClipboard(text){
  return new Promise((resolve)=>{
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(text).then(()=>resolve(true)).catch(()=>{
        resolve(fallbackCopy(text));
      });
    } else {
      resolve(fallbackCopy(text));
    }
  });
}
function fallbackCopy(text){
  try{
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  }catch(e){ return false; }
}
async function copyZaloMessage(classId, studentId){
  const text = buildZaloMessage(classId, studentId);
  if(!text){ showToast('Chưa chọn được học sinh để tạo tin nhắn.'); return; }
  const ok = await copyTextToClipboard(text);
  if(ok){
    showToast('Đã copy tin nhắn — dán trực tiếp vào Zalo để gửi phụ huynh.', 3200);
  } else {
    openPromptModal('Copy tin nhắn Zalo', text, ()=>{}, {
      multiline:true,
      submitLabel:'Đóng',
      hint:'Trình duyệt chặn copy tự động — cô bôi đen (Ctrl+A) rồi Ctrl+C nội dung bên dưới nhé.'
    });
  }
}

// Tạo nội dung báo cáo 1 buổi học, đúng theo bố cục/màu sắc của mẫu docx người dùng cung cấp:
// tiêu đề navy #1F3864, bảng thông tin nền #DDEBF7, tiêu đề mục có gạch chân #2E74B5,
// bảng điểm số có header nền #1F3864 chữ trắng.
function buildSessionReportHtml(classId, date){
  const cls = getClass(classId);
  const session = (state.sessionsByClass[classId]||[]).find(s=>s.date===date);
  const students = cls ? cls.students : [];
  let maxS=null, minS=null, avgS=null;
  if(session){
    const scores = students.map(s=>sessionScoreAvg(session, s.id)).filter(v=>v!==null);
    if(scores.length){
      maxS = Math.max(...scores); minS = Math.min(...scores);
      avgS = scores.reduce((a,b)=>a+b,0)/scores.length;
    }
  }
  const content = session ? session.content : '';
  const disciplineNote = session ? session.disciplineNote : '';
  const noteLines = session && session.generalNote ? session.generalNote.split(/\r?\n/).map(l=>l.trim()).filter(Boolean) : [];
  const hwLines = session && session.homework ? session.homework.split(/\r?\n/).map(l=>l.trim()).filter(Boolean) : [];

  const ph = (val, placeholder) => (val && val.trim()) ? esc(val) : `<span style="color:#808080;font-style:italic;">${esc(placeholder)}</span>`;
  const scoreCell = (v) => v!==null ? v.toFixed(1) : `<span style="color:#808080;font-style:italic;">—</span>`;
  const bulletsOrPlaceholder = (arr, placeholder) => arr.length
    ? arr.map(l=>`<li>${esc(l)}</li>`).join('')
    : `<li style="color:#808080;font-style:italic;">${esc(placeholder)}</li>`;

  const infoRow = (label, value) => `<tr>
    <td style="background:#DDEBF7;color:#1F3864;font-weight:bold;width:28%;padding:8px 10px;border:1px solid #BFBFBF;">${esc(label)}</td>
    <td style="padding:8px 10px;border:1px solid #BFBFBF;">${value}</td>
  </tr>`;

  return `
  <div style="font-family:Calibri,Arial,sans-serif;color:#000;font-size:16.5px;line-height:1.5;max-width:700px;">
    <div style="text-align:right;color:#808080;font-size:11.5px;margin-bottom:14px;">Báo cáo học tập — Tiếng Anh</div>
    <div style="text-align:center;color:#1F3864;font-weight:bold;font-size:25.5px;margin-bottom:18px;">BÁO CÁO HỌC TẬP</div>

    <table style="width:100%;border-collapse:collapse;margin-bottom:22px;">
      ${infoRow('Lớp', esc(cls ? cls.name : ''))}
      ${infoRow('Môn học', 'Tiếng Anh')}
      ${infoRow('Ngày học', esc(fmtDateVN(date)))}
      ${infoRow('Giáo viên', ph(state.teacherName, '[Chưa nhập tên giáo viên]'))}
    </table>

    <div style="color:#1F3864;font-weight:bold;font-size:18.5px;border-bottom:1px solid #2E74B5;padding-bottom:5px;margin-bottom:10px;">1. Nhận xét về nền nếp</div>
    <p style="margin:0 0 18px;">${ph(disciplineNote, '[Chưa nhập nhận xét về nền nếp]')}</p>

    <div style="color:#1F3864;font-weight:bold;font-size:18.5px;border-bottom:1px solid #2E74B5;padding-bottom:5px;margin-bottom:10px;">2. Nhận xét về học tập</div>
    <p style="color:#2E74B5;font-weight:bold;font-size:15px;margin:10px 0 5px;">Nội dung học bài</p>
    <p style="margin:0 0 14px;">${ph(content, '[Chưa nhập nội dung bài học]')}</p>

    <p style="color:#2E74B5;font-weight:bold;font-size:15px;margin:10px 0 5px;">Các điểm số trên lớp</p>
    <table style="width:100%;border-collapse:collapse;margin-bottom:16px;">
      <tr>
        <td style="background:#1F3864;color:#fff;font-weight:bold;text-align:center;padding:8px;border:1px solid #BFBFBF;">Điểm cao nhất</td>
        <td style="background:#1F3864;color:#fff;font-weight:bold;text-align:center;padding:8px;border:1px solid #BFBFBF;">Điểm thấp nhất</td>
        <td style="background:#1F3864;color:#fff;font-weight:bold;text-align:center;padding:8px;border:1px solid #BFBFBF;">Điểm trung bình lớp</td>
      </tr>
      <tr>
        <td style="text-align:center;padding:8px;border:1px solid #BFBFBF;">${scoreCell(maxS)}</td>
        <td style="text-align:center;padding:8px;border:1px solid #BFBFBF;">${scoreCell(minS)}</td>
        <td style="text-align:center;padding:8px;border:1px solid #BFBFBF;">${scoreCell(avgS)}</td>
      </tr>
    </table>

    <p style="color:#2E74B5;font-weight:bold;font-size:15px;margin:14px 0 5px;">Các lưu ý của buổi học</p>
    <ul style="margin:0 0 18px;padding-left:22px;">${bulletsOrPlaceholder(noteLines, '[Chưa có lưu ý nào cho buổi học]')}</ul>

    <div style="color:#1F3864;font-weight:bold;font-size:18.5px;border-bottom:1px solid #2E74B5;padding-bottom:5px;margin-bottom:10px;">3. Bài tập về nhà</div>
    <ul style="margin:0;padding-left:22px;">${bulletsOrPlaceholder(hwLines, '[Chưa giao bài tập về nhà]')}</ul>
  </div>`;
}

function exportSessionWordTemplate(){
  const classId = state.currentClassId;
  const date = state.session.date;
  const cls = getClass(classId);
  if(!cls){ showToast('Chưa chọn lớp.'); return; }
  const bodyHtml = buildSessionReportHtml(classId, date);
  const full = `<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
  <head><meta charset="utf-8"><title>Báo cáo buổi học</title></head>
  <body>${bodyHtml}</body></html>`;
  const blob = new Blob(['\ufeff', full], {type:'application/msword'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Bao-cao-buoi-hoc-${cls.name.replace(/\s+/g,'_')}-${date}.doc`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('Đã xuất báo cáo buổi học theo mẫu.');
}

function buildSessionReportPrompt(classId, date){
  const cls = getClass(classId);
  if(!cls) return '';
  const students = cls.students;
  const session = (state.sessionsByClass[classId]||[]).find(s=>s.date===date) || newSession(date);
  const types = session.exerciseTypes || [];
  const exercises = session.exercises || [];

  const scores = students.map(s=>sessionScoreAvg(session, s.id)).filter(v=>v!==null);
  const maxS = scores.length? Math.max(...scores) : null;
  const minS = scores.length? Math.min(...scores) : null;
  const avgS = scores.length? scores.reduce((a,b)=>a+b,0)/scores.length : null;

  const L = [];
  L.push('Bạn là trợ lý giúp giáo viên soạn một BÁO CÁO BUỔI HỌC hoàn chỉnh dưới dạng FILE WORD (.docx), có bố cục chuyên nghiệp, sẵn sàng in ấn hoặc gửi cho phụ huynh/BGH.');
  L.push('');
  L.push(`Lớp: ${cls.name}`);
  L.push(`Ngày học: ${fmtDateVN(date)}`);
  L.push(`Giáo viên: ${state.teacherName || '(chưa nhập tên)'}`);
  L.push(`Sĩ số: ${students.length} học sinh`);
  L.push(`Nội dung học tập: ${session.content || '(chưa nhập)'}`);
  L.push(`Nhận xét về nền nếp: ${session.disciplineNote || '(chưa nhập)'}`);
  if(scores.length){
    L.push(`Điểm buổi học — Cao nhất: ${maxS.toFixed(1)} · Thấp nhất: ${minS.toFixed(1)} · Trung bình lớp: ${avgS.toFixed(1)}`);
  }
  L.push('');

  L.push('=== BẢNG CHI TIẾT TỪNG HỌC SINH ===');
  students.forEach(st=>{
    const att = session.attendance[st.id];
    const attLabel = att==='present' ? 'Có mặt' : att==='absent' ? 'Vắng' : att==='late' ? 'Muộn' : 'Chưa điểm danh';
    const checklistPart = types.length ? types.map(t=>{
      const v = (session.checklist[st.id]||{})[t.id] || 'none';
      const label = v==='full' ? 'Đầy đủ' : v==='partial' ? 'Thiếu' : 'Chưa làm';
      return `${t.name}: ${label}`;
    }).join(', ') : '';
    const scorePart = exercises.length ? exercises.map(e=>{
      const total = exerciseTotal(e);
      const raw = (session.scores[st.id]||{})[e.id];
      const s10 = scoreOn10(raw, total);
      return `${e.name}: ${raw!==undefined && raw!==null ? raw+'/'+total+' câu ('+s10.toFixed(1)+'/10)' : 'chưa chấm'}`;
    }).join(', ') : '';
    const note = session.studentNotes[st.id] || '';
    const owesPunish = studentOwesPunishment(classId, st.id, date) || (session.punishmentAssigned && session.punishmentAssigned[st.id]);

    const parts = [`- ${st.name}: Điểm danh ${attLabel}`];
    if(checklistPart) parts.push(`Checklist [${checklistPart}]`);
    if(scorePart) parts.push(`Điểm [${scorePart}]`);
    if(owesPunish) parts.push('⚠ Có chép phạt cần theo dõi');
    if(note) parts.push(`Ghi chú: ${note}`);
    L.push(parts.join(' · '));
  });

  L.push('');
  L.push('=== LƯU Ý CỦA BUỔI HỌC ===');
  L.push(session.generalNote || '(chưa nhập)');
  L.push('');
  L.push('=== BÀI TẬP VỀ NHÀ ===');
  L.push(session.homework || '(chưa nhập)');
  L.push('');
  L.push('=== YÊU CẦU ===');
  L.push('Hãy tạo cho tôi MỘT FILE WORD (.docx) báo cáo buổi học hoàn chỉnh dựa trên dữ liệu trên, bố cục gồm:');
  L.push('1. Tiêu đề báo cáo, thông tin buổi học (lớp, ngày, giáo viên, nội dung học, điểm cao nhất/thấp nhất/trung bình) trình bày dạng bảng thông tin gọn gàng ở đầu trang.');
  L.push('2. Bảng chi tiết từng học sinh (điểm danh, checklist, điểm số, đánh giá, ghi chú) — dùng định dạng bảng chuẩn của Word, có tô nền/in đậm để làm nổi bật học sinh vắng, điểm thấp hoặc có chép phạt.');
  L.push('3. Mục "Lưu ý của buổi học" và "Bài tập về nhà" trình bày dạng danh sách gạch đầu dòng, có tiêu đề mục rõ ràng (heading).');
  L.push('4. Bố cục chuyên nghiệp: có tiêu đề lớn ở đầu, các mục có heading phân cấp rõ ràng, phông chữ và khoảng cách hợp lý, canh lề chuẩn để in ấn trên khổ A4.');
  L.push('5. Xuất trực tiếp file .docx hoàn chỉnh (không phải HTML hay trang web) để tôi tải về dùng ngay.');
  return L.join('\n');
}

function exportWordDoc(){
  const area = document.getElementById('report-print-area');
  if(!area) return;
  const html = `<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
  <head><meta charset="utf-8"><title>Báo cáo</title></head>
  <body style="font-family:Calibri, Arial, sans-serif; color:#22333B;">${area.innerHTML}</body></html>`;
  const blob = new Blob(['\ufeff', html], {type:'application/msword'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const isClassMode = state.report.mode === 'class';
  const cls = getClass(state.report.classId || state.currentClassId);
  const st = !isClassMode && cls ? cls.students.find(s=>s.id===(state.report.studentId)) : null;
  a.href = url;
  a.download = isClassMode
    ? `Bao-cao-lop-${(cls?cls.name:'lop').replace(/\s+/g,'_')}.doc`
    : `Bao-cao-${st? st.name.replace(/\s+/g,'_'):'hoc-sinh'}.doc`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('Đã xuất file Word.');
}
/* ============================================================
   TOAST
============================================================ */
let toastTimer;
function showToast(msg, duration){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=> t.classList.remove('show'), duration || 2400);
}

/* ============================================================
   EVENT HANDLERS
============================================================ */
function attachHandlers(){
  const app = document.getElementById('app');

  app.querySelectorAll('[data-nav]').forEach(elx=>{
    elx.addEventListener('click', ()=>{ state.tab = elx.dataset.nav; render(); });
  });

  app.querySelectorAll('[data-action]').forEach(elx=>{
    const action = elx.dataset.action;
    const evt = (elx.tagName==='INPUT' || elx.tagName==='SELECT' || elx.tagName==='TEXTAREA') ?
      (elx.type==='text'||elx.type==='number'||elx.tagName==='TEXTAREA' ? 'change' : 'change') : 'click';
    elx.addEventListener(evt, (e)=> handleAction(action, elx, e));
    if((elx.tagName==='INPUT' && (elx.type==='text')) || elx.tagName==='TEXTAREA'){
      elx.addEventListener('blur', (e)=> handleAction(action, elx, e));
    }
  });

  // textarea/content fields with data-field
  app.querySelectorAll('[data-field]').forEach(elx=>{
    elx.addEventListener('change', ()=> handleFieldChange(elx));
    elx.addEventListener('blur', ()=> handleFieldChange(elx));
  });

  // cập nhật ngay hiển thị "x.x/10" khi gõ số câu đúng, và cập nhật luôn bảng Tổng kết buổi (Cao nhất/Thấp nhất/TB lớp) của đúng bài đó
  function recomputeExerciseSummary(exerciseId){
    const inputs = app.querySelectorAll('.score-input[data-exercise="'+exerciseId+'"]');
    const vals = [];
    inputs.forEach(inp=>{
      if(inp.value==='') return;
      if(inp.dataset.mode==='scale10'){ vals.push(clamp(Number(inp.value),0,10)); }
      else { const total = Number(inp.dataset.total)||10; vals.push(clamp(Number(inp.value),0,total)/total*10); }
    });
    const row = app.querySelector('[data-summary-exercise="'+exerciseId+'"]');
    if(!row) return;
    const maxEl = row.querySelector('.summary-max'), minEl = row.querySelector('.summary-min'), avgEl = row.querySelector('.summary-avg');
    if(maxEl) maxEl.textContent = vals.length ? Math.max(...vals).toFixed(1) : '—';
    if(minEl) minEl.textContent = vals.length ? Math.min(...vals).toFixed(1) : '—';
    if(avgEl) avgEl.textContent = vals.length ? (vals.reduce((a,b)=>a+b,0)/vals.length).toFixed(1) : '—';
  }
  app.querySelectorAll('.score-input').forEach(inp=>{
    inp.addEventListener('input', ()=>{
      if(inp.dataset.mode!=='scale10'){
        const total = Number(inp.dataset.total) || 10;
        const span = inp.parentElement && inp.parentElement.querySelector('.score-computed');
        if(span){
          const val = inp.value;
          if(val===''){ span.textContent = '—'; }
          else { const c = clamp(Number(val), 0, total); span.textContent = ((c/total)*10).toFixed(1)+'/10'; }
        }
      }
      recomputeExerciseSummary(inp.dataset.exercise);
    });
  });

  const exModeSel = app.querySelector('#new-exercise-mode');
  const exTotalInput = app.querySelector('#new-exercise-total');
  if(exModeSel && exTotalInput){
    const syncExMode = ()=>{ exTotalInput.style.display = exModeSel.value==='scale10' ? 'none' : ''; };
    syncExMode();
    exModeSel.addEventListener('change', syncExMode);
  }

  const modalInput = app.querySelector('#modal-input');
  if(modalInput){
    modalInput.addEventListener('keydown', (ev)=>{
      const isTextarea = modalInput.tagName==='TEXTAREA';
      if(ev.key==='Enter' && (!isTextarea || ev.ctrlKey || ev.metaKey)){
        ev.preventDefault(); const btn = app.querySelector('[data-action="modal-submit"]'); if(btn) btn.click();
      }
      if(ev.key==='Escape'){ ev.preventDefault(); closeModal(); }
    });
  }

  const search = app.querySelector('[data-action="progress-search"]');
  if(search){
    search.addEventListener('input', (e)=>{ state.progress.query = e.target.value; render(); setTimeout(()=>{ const i=app.querySelector('[data-action="progress-search"]'); if(i){ i.focus(); i.setSelectionRange(i.value.length,i.value.length);} },0); });
  }
  const globalSearchInput = app.querySelector('#global-student-search');
  if(globalSearchInput){
    globalSearchInput.addEventListener('input', (e)=>{ state.globalSearch = e.target.value; render(); setTimeout(()=>{ const i=app.querySelector('#global-student-search'); if(i){ i.focus(); i.setSelectionRange(i.value.length,i.value.length);} },0); });
    globalSearchInput.addEventListener('keydown', (e)=>{ if(e.key==='Escape'){ state.globalSearch=''; render(); } });
  }
  const backupInput = app.querySelector('#backup-file-input');
  if(backupInput){
    backupInput.addEventListener('change', (e)=>{
      const file = e.target.files && e.target.files[0];
      if(file) importBackup(file);
      backupInput.value = '';
    });
  }
}

async function handleFieldChange(elx){
  const sess = ensureSessionEditable();
  sess[elx.dataset.field] = elx.value;
  saveSessions(state.currentClassId);
}

async function handleAction(action, elx, e){
  switch(action){

    case 'go-classes': state.tab='classes'; render(); break;
    case 'export-backup': exportBackup(); break;
    case 'trigger-backup-import': { const inp = document.getElementById('backup-file-input'); if(inp) inp.click(); break; }
    case 'logout': logout(); break;
    case 'change-password': changePassword(); break;
    case 'resync': {
      if(!store.uid){ break; }
      flushPendingSaves();
      showToast('Đang đồng bộ lại…', 2000);
      const keepTab = state.tab, keepClass = state.currentClassId;
      await store.init(store.uid);
      loadAll();
      state.tab = keepTab;
      if(getClass(keepClass)) state.currentClassId = keepClass;
      render();
      showToast(syncStatus==='synced' ? 'Đã đồng bộ xong.' : 'Chưa kết nối được — dữ liệu vẫn lưu trên máy.', 3000);
      break;
    }

    case 'goto-session-date': {
      state.currentClassId = elx.dataset.class;
      state.session.date = elx.dataset.date;
      state.tab = 'session';
      render();
      break;
    }
    /* ---- Modal ---- */
    case 'modal-cancel': closeModal(); break;
    case 'modal-backdrop': if(e && e.target===elx) closeModal(); break;
    case 'modal-input': break;
    case 'modal-submit': {
      const m = state.modal;
      if(!m) break;
      if(m.type==='prompt'){
        const input = document.getElementById('modal-input');
        const val = input ? input.value : '';
        const cb = m.onSubmit;
        state.modal = null;
        if(cb) cb(val);
        render();
      } else {
        const cb = m.onSubmit;
        state.modal = null;
        if(cb) cb();
        render();
      }
      break;
    }

    /* ---- Classes ---- */
    case 'add-class': {
      openPromptModal('Tên lớp học', '', (name)=>{
        if(name && name.trim()){
          const c = {id:uid(), name:name.trim(), students:[]};
          state.classes.push(c);
          state.currentClassId = c.id;
          saveClasses();
        }
      });
      break;
    }
    case 'rename-class': {
      const c = getClass(elx.dataset.id);
      openPromptModal('Đổi tên lớp', c.name, (name)=>{
        if(name && name.trim()){ c.name = name.trim(); saveClasses(); }
      });
      break;
    }
    case 'delete-class': {
      const id = elx.dataset.id;
      openConfirmModal('Xoá lớp này? Toàn bộ dữ liệu buổi học của lớp sẽ bị xoá.', true, ()=>{
        state.classes = state.classes.filter(c=>c.id!==id);
        delete state.sessionsByClass[id];
        removeClassSessions(id);
        if(state.currentClassId===id) state.currentClassId = state.classes[0]? state.classes[0].id : null;
        saveClasses();
      });
      break;
    }
    case 'select-class': state.currentClassId = elx.dataset.id; render(); break;
    case 'add-student': {
      const c = getClass(state.currentClassId);
      openPromptModal('Thêm học sinh', '', (text)=>{
        const names = text.split(/\r?\n|,|;/)
          .map(s=> s.trim().replace(/^(\d+[\.\)]|[-•*])\s*/,'').trim())
          .filter(Boolean);
        if(names.length){
          names.forEach(name=> c.students.push({id:uid(), name}));
          saveClasses();
        }
      }, {
        multiline:true,
        showListTip:true,
        placeholder:'Nguyễn Văn A\nTrần Thị B\nLê Văn C\n...',
        hint:'Dán cả danh sách (mỗi học sinh một dòng) hoặc gõ từng tên — mỗi dòng sẽ tự tách thành một học sinh.'
      });
      break;
    }
    case 'rename-student': {
      const c = getClass(state.currentClassId);
      const s = c.students.find(x=>x.id===elx.dataset.id);
      openPromptModal('Sửa tên học sinh', s.name, (name)=>{
        if(name && name.trim()){ s.name = name.trim(); saveClasses(); }
      });
      break;
    }
    case 'delete-student': {
      const c = getClass(state.currentClassId);
      const sid = elx.dataset.id;
      openConfirmModal('Xoá học sinh này khỏi lớp?', true, ()=>{
        c.students = c.students.filter(x=>x.id!==sid);
        saveClasses();
      });
      break;
    }

    /* ---- Session ---- */
    case 'change-class-session': state.currentClassId = elx.value; state.session.prompt=''; render(); break;
    case 'change-session-date': state.session.date = elx.value; state.session.prompt=''; render(); break;
    case 'delete-session': {
      const classId = state.currentClassId, date = state.session.date;
      openConfirmModal(`Xoá toàn bộ dữ liệu buổi học ngày ${fmtDateVN(date)}? Điểm danh, checklist, điểm số và ghi chú của buổi này sẽ mất hết.`, true, ()=>{
        const list = state.sessionsByClass[classId] || [];
        state.sessionsByClass[classId] = list.filter(s=>s.date!==date);
        render(); saveSessions(classId);
      });
      break;
    }
    case 'set-teacher-name': state.teacherName = elx.value; saveTeacherName(); break;
    case 'export-session-doc': exportSessionWordTemplate(); break;
    case 'generate-session-prompt': {
      state.session.prompt = buildSessionReportPrompt(elx.dataset.class, elx.dataset.date);
      render();
      break;
    }
    case 'copy-session-prompt': {
      const el = document.getElementById('session-prompt-text');
      const text = el ? el.value : state.session.prompt;
      copyTextToClipboard(text).then(ok=>{
        showToast(ok ? 'Đã copy prompt — dán vào công cụ AI để tạo bảng báo cáo.' : 'Không copy được, cô bôi đen (Ctrl+A) rồi Ctrl+C nhé.', 3200);
      });
      break;
    }
    case 'set-att': {
      const sess = ensureSessionEditable();
      sess.attendance[elx.dataset.student] = elx.dataset.value;
      render(); saveSessions(state.currentClassId);
      break;
    }
    case 'tick-all-attendance': {
      const sess = ensureSessionEditable();
      getStudents(state.currentClassId).forEach(st=>{ sess.attendance[st.id] = 'present'; });
      render(); saveSessions(state.currentClassId);
      showToast('Đã tick cả lớp là Có mặt.');
      break;
    }
    case 'tick-all-checklist': {
      const sess = ensureSessionEditable();
      const typeId = elx.dataset.type;
      getStudents(state.currentClassId).forEach(st=>{
        if(sess.attendance[st.id]==='absent') return; // học sinh vắng — bỏ qua, không tick
        if(!sess.checklist[st.id]) sess.checklist[st.id] = {};
        sess.checklist[st.id][typeId] = 'full';
      });
      render(); saveSessions(state.currentClassId);
      showToast('Đã tick cả lớp là Đầy đủ (trừ học sinh vắng).');
      break;
    }
    case 'add-extype': {
      const input = document.getElementById('new-extype');
      if(input && input.value.trim()){
        const sess = ensureSessionEditable();
        sess.exerciseTypes.push({id:uid(), name:input.value.trim()});
        render(); saveSessions(state.currentClassId);
      }
      break;
    }
    case 'del-extype': {
      const sess = ensureSessionEditable();
      sess.exerciseTypes = sess.exerciseTypes.filter(t=>t.id!==elx.dataset.id);
      Object.keys(sess.checklist).forEach(sid=>{ delete sess.checklist[sid][elx.dataset.id]; });
      render(); saveSessions(state.currentClassId);
      break;
    }
    case 'cycle-check': {
      const sess = ensureSessionEditable();
      const sid = elx.dataset.student, tid = elx.dataset.type;
      if(!sess.checklist[sid]) sess.checklist[sid] = {};
      const cur = sess.checklist[sid][tid] || 'none';
      const next = cur==='none' ? 'partial' : (cur==='partial' ? 'full' : 'none');
      sess.checklist[sid][tid] = next;
      render(); saveSessions(state.currentClassId);
      break;
    }
    case 'add-exercise': {
      const input = document.getElementById('new-exercise');
      const modeSel = document.getElementById('new-exercise-mode');
      const totalInput = document.getElementById('new-exercise-total');
      const name = input ? input.value.trim() : '';
      const mode = modeSel ? modeSel.value : 'fraction';
      if(!name){ showToast('Nhập tên bài luyện tập nhé.'); break; }
      const sess = ensureSessionEditable();
      if(mode==='scale10'){
        sess.exercises.push({id:uid(), name, mode:'scale10'});
        render(); saveSessions(state.currentClassId);
      } else {
        const total = totalInput ? parseInt(totalInput.value, 10) : NaN;
        if(!(total>0)){ showToast('Nhập tổng số câu (lớn hơn 0) nhé.'); break; }
        sess.exercises.push({id:uid(), name, mode:'fraction', totalQuestions: total});
        render(); saveSessions(state.currentClassId);
      }
      break;
    }
    case 'del-exercise': {
      const sess = ensureSessionEditable();
      sess.exercises = sess.exercises.filter(x=>x.id!==elx.dataset.id);
      Object.keys(sess.scores).forEach(sid=>{ delete sess.scores[sid][elx.dataset.id]; });
      if(state.session.sortKey === elx.dataset.id) state.session.sortKey = 'default';
      render(); saveSessions(state.currentClassId);
      break;
    }
    case 'session-sort-key': state.session.sortKey = elx.value; render(); break;
    case 'session-sort-dir': state.session.sortDir = elx.value; render(); break;
    case 'reset-scores': {
      openConfirmModal('Đặt lại toàn bộ điểm bài luyện tập của buổi này? Các bài đã tạo vẫn được giữ nguyên, chỉ xoá điểm đã nhập.', true, ()=>{
        const sess = ensureSessionEditable();
        sess.scores = {};
        render(); saveSessions(state.currentClassId);
      });
      break;
    }
    case 'set-score': {
      const sess = ensureSessionEditable();
      const sid = elx.dataset.student, exid = elx.dataset.exercise;
      const total = Number(elx.dataset.total) || 10;
      const mode = elx.dataset.mode || 'fraction';
      if(!sess.scores[sid]) sess.scores[sid] = {};
      const val = elx.value;
      if(val===''){ delete sess.scores[sid][exid]; }
      else if(mode==='scale10'){
        sess.scores[sid][exid] = Math.round(clamp(Number(val),0,10)*10)/10;
      } else {
        sess.scores[sid][exid] = clamp(Math.round(Number(val)),0,total);
      }
      saveSessions(state.currentClassId);
      break;
    }
    case 'toggle-punishment-done': {
      const sess = ensureSessionEditable();
      if(!sess.punishmentDone) sess.punishmentDone = {};
      sess.punishmentDone[elx.dataset.student] = elx.checked;
      saveSessions(state.currentClassId);
      break;
    }
    case 'toggle-punishment-assign': {
      const sess = ensureSessionEditable();
      if(!sess.punishmentAssigned) sess.punishmentAssigned = {};
      sess.punishmentAssigned[elx.dataset.student] = elx.checked;
      saveSessions(state.currentClassId);
      break;
    }
    case 'set-note': {
      const sess = ensureSessionEditable();
      sess.studentNotes[elx.dataset.student] = elx.value;
      saveSessions(state.currentClassId);
      break;
    }

    /* ---- Report ---- */
    case 'report-change-class': state.report.classId = elx.value; state.report.studentId=null; render(); break;
    case 'report-change-infographic-date': state.report.infographicDate = elx.value; render(); break;
    case 'report-change-infographic-score-mode': state.report.infographicScoreMode = elx.value; render(); break;
    case 'generate-session-infographic-prompt': {
      const text = buildSessionInfographicPrompt(elx.dataset.class, elx.dataset.date, elx.dataset.scoreMode);
      if(text){ state.report.infographicPrompt = text; render(); }
      else { showToast('Không tạo được prompt — chưa có dữ liệu buổi học này.'); }
      break;
    }
    case 'copy-session-infographic-prompt': {
      const el = document.getElementById('session-infographic-prompt-text');
      const text = el ? el.value : state.report.infographicPrompt;
      copyTextToClipboard(text).then(ok=>{
        showToast(ok ? 'Đã copy — dán vào ChatGPT để tạo infographic.' : 'Không copy được, cô bôi đen (Ctrl+A) rồi Ctrl+C nhé.', 3200);
      });
      break;
    }
    case 'report-change-student': state.report.studentId = elx.value; render(); break;
    case 'report-set-mode': state.report.mode = elx.dataset.mode; render(); break;
    case 'goto-report':
      state.report.classId = elx.dataset.class; state.report.studentId = elx.dataset.student; state.report.mode='student';
      state.tab = 'report'; render(); break;
    case 'export-doc': exportWordDoc(); break;
    case 'copy-zalo': copyZaloMessage(elx.dataset.class, elx.dataset.student); break;

    /* ---- Progress ---- */
    case 'progress-select':
      state.progress.classId = elx.dataset.class; state.progress.studentId = elx.dataset.student; state.progress.query=''; render(); break;
    case 'progress-class-overview':
      state.progress.classId = elx.dataset.class; state.progress.studentId = null; render(); break;
    case 'progress-pick':
      state.progress.classId = elx.dataset.class; state.progress.studentId = elx.dataset.student; render(); break;
    case 'progress-to-report':
      state.report.classId = elx.dataset.class; state.report.studentId = elx.dataset.student; state.report.mode='student'; state.tab='report'; render(); break;

  }
}

/* ============================================================
   KHUNG GIAO DIỆN
============================================================ */
const NAV = [
  {id:'session',  icon:'✎', label:'Buổi học', group:'daily'},
  {id:'classes',  icon:'▤', label:'Lớp học',  group:'daily'},
  {id:'report',   icon:'▣', label:'Báo cáo',  group:'track'},
  {id:'progress', icon:'∿', label:'Tiến độ',  group:'track'},
  {id:'account',  icon:'⚙', label:'Tài khoản & dữ liệu', group:'system'},
];
const NAV_GROUPS = [
  {key:'daily',  label:'Trên lớp'},
  {key:'track',  label:'Theo dõi'},
  {key:'system', label:'Hệ thống'},
];

function brandMark(){
  return `<div class="brand-mark" aria-hidden="true">
    <svg viewBox="0 0 32 32" width="22" height="22"><path d="M4 9.5 16 4l12 5.5-12 5.5L4 9.5Z" fill="currentColor"/><path d="M9 12.8v6.2c0 1.9 3.1 3.6 7 3.6s7-1.7 7-3.6v-6.2l-7 3.2-7-3.2Z" fill="currentColor" opacity=".75"/><path d="M27 10v7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
  </div>`;
}

function render(){
  const app = document.getElementById('app');
  if(!state.authReady){
    app.innerHTML = `<div class="boot">${brandMark()}<div>Đang mở ${APP_NAME}…</div></div>`;
    return;
  }
  if(state.setupIssue){ app.innerHTML = renderSetupIssue(); attachSetupHandlers(); return; }
  if(cloudEnabled() && !state.user){ app.innerHTML = renderLogin(); attachAuthHandlers(); return; }
  if(!state.loaded){
    app.innerHTML = `<div class="boot">${brandMark()}<div>Đang tải dữ liệu lớp học…</div></div>`;
    return;
  }

  const q = (state.globalSearch||'').trim().toLowerCase();
  let matches = [];
  if(q){
    state.classes.forEach(c=> c.students.forEach(s=>{
      if(s.name.toLowerCase().includes(q)) matches.push({id:s.id, name:s.name, classId:c.id, className:c.name});
    }));
    matches = matches.slice(0,8);
  }

  app.innerHTML = `
    <aside class="sidebar no-print">
      <div class="brand">
        ${brandMark()}
        <div>
          <div class="brand-name">EDU ASSISTANT</div>
          <div class="brand-sub">Sổ tay giáo viên</div>
        </div>
      </div>
      <div class="global-search-wrap">
        <input type="text" id="global-student-search" placeholder="🔍 Tìm học sinh…" value="${esc(state.globalSearch||'')}" autocomplete="off">
        ${q ? `<div class="global-search-results">
          ${matches.length ? matches.map(m=>`
            <div class="global-search-item" data-action="progress-select" data-student="${m.id}" data-class="${m.classId}">
              <b>${esc(m.name)}</b><span class="tiny">${esc(m.className)}</span>
            </div>`).join('') : `<div class="global-search-item tiny" style="cursor:default;">Không tìm thấy học sinh nào.</div>`}
        </div>` : ''}
      </div>
      ${NAV_GROUPS.map(g=>`
        <div class="nav-group-label">${g.label}</div>
        ${NAV.filter(n=>n.group===g.key).map(n=>`
          <div class="nav-item ${state.tab===n.id?'active':''}" data-nav="${n.id}">
            <span class="nav-icon">${n.icon}</span><span>${n.label}</span>
          </div>`).join('')}
      `).join('')}
      <div class="sidebar-foot">
        <div class="who">👤 ${esc(displayIdOf(state.user))}</div>
        <div data-sync-pill class="sync-pill"></div>
        <div class="tiny" style="margin-top:8px;opacity:.7;">Phiên bản ${APP_VERSION}</div>
      </div>
    </aside>
    <input type="file" id="backup-file-input" accept=".json" style="display:none;">
    <main class="main">${renderTab()}</main>
    ${renderModal()}
  `;
  setSyncStatus(store.uid ? syncStatus : 'local');
  attachHandlers();
}

function renderTab(){
  switch(state.tab){
    case 'classes': return renderClasses();
    case 'session': return renderSession();
    case 'report': return renderReport();
    case 'progress': return renderProgress();
    case 'account': return renderAccount();
    default: return renderSession();
  }
}

/* ============================================================
   ĐĂNG NHẬP / TẠO TÀI KHOẢN
============================================================ */
function renderLogin(){
  const reg = state.authMode === 'register';
  return `
  <div class="auth-wrap">
    <div class="auth-card">
      <div class="auth-brand">${brandMark()}<div><div class="brand-name">EDU ASSISTANT</div><div class="brand-sub">Sổ tay giáo viên</div></div></div>
      <h2>${reg ? 'Tạo tài khoản mới' : 'Đăng nhập'}</h2>
      <p class="muted" style="margin:4px 0 18px;">${reg ? 'Chọn một ID và mật khẩu riêng. Dữ liệu lớp học của cô chỉ tài khoản này xem được.' : 'Mỗi giáo viên một tài khoản riêng — đăng nhập trên máy nào cũng thấy đúng dữ liệu của mình.'}</p>
      <form id="auth-form" autocomplete="on">
        <label class="field-label" for="auth-id">ID đăng nhập</label>
        <input type="text" id="auth-id" name="username" autocomplete="username" placeholder="VD: cohanh.tv" autocapitalize="none" spellcheck="false" required>
        <label class="field-label" for="auth-pass" style="margin-top:12px;">Mật khẩu</label>
        <input type="password" id="auth-pass" name="password" autocomplete="${reg?'new-password':'current-password'}" placeholder="Ít nhất 6 ký tự" required>
        ${reg ? `<label class="field-label" for="auth-pass2" style="margin-top:12px;">Nhập lại mật khẩu</label>
        <input type="password" id="auth-pass2" autocomplete="new-password" required>` : ''}
        ${state.authError ? `<div class="auth-error">${esc(state.authError)}</div>` : ''}
        <button type="submit" class="btn btn-accent auth-submit" ${state.authBusy?'disabled':''}>${state.authBusy ? 'Đang xử lý…' : (reg ? 'Tạo tài khoản' : 'Đăng nhập')}</button>
      </form>
      <div class="auth-switch">
        ${reg ? 'Đã có tài khoản?' : 'Chưa có tài khoản?'}
        <button class="linklike" id="auth-toggle">${reg ? 'Đăng nhập' : 'Tạo tài khoản'}</button>
      </div>
      <div class="tiny" style="margin-top:14px;line-height:1.6;">ID chỉ gồm chữ không dấu, số, dấu chấm hoặc gạch ngang. Có thể dùng email làm ID. Hãy ghi nhớ mật khẩu — ID không phải email thì không lấy lại mật khẩu qua thư được.</div>
    </div>
  </div>`;
}

function attachAuthHandlers(){
  const form = document.getElementById('auth-form');
  const toggle = document.getElementById('auth-toggle');
  if(toggle) toggle.addEventListener('click', ()=>{ state.authMode = state.authMode==='login' ? 'register' : 'login'; state.authError=''; render(); });
  if(!form) return;
  form.addEventListener('submit', async (e)=>{
    e.preventDefault();
    const id = document.getElementById('auth-id').value.trim();
    const pass = document.getElementById('auth-pass').value;
    const reg = state.authMode === 'register';
    if(!id.includes('@') && !/^[a-zA-Z0-9._-]{3,30}$/.test(id)){ state.authError = 'ID cần 3–30 ký tự: chữ không dấu, số, dấu chấm, gạch dưới hoặc gạch ngang.'; render(); return; }
    if(reg){
      const pass2 = document.getElementById('auth-pass2').value;
      if(pass.length < 6){ state.authError = 'Mật khẩu cần ít nhất 6 ký tự.'; render(); return; }
      if(pass !== pass2){ state.authError = 'Hai lần nhập mật khẩu chưa khớp.'; render(); return; }
    }
    state.authBusy = true; state.authError = ''; render();
    try{
      const email = loginIdToEmail(id);
      if(reg) await fbAuth.createUserWithEmailAndPassword(email, pass);
      else await fbAuth.signInWithEmailAndPassword(email, pass);
      // onAuthStateChanged sẽ nạp dữ liệu
    }catch(err){
      state.authError = authErrorMessage(err);
    }finally{
      state.authBusy = false;
      render();
      const i = document.getElementById('auth-id'); if(i && !i.value) i.value = id;
    }
  });
}

/* ============================================================
   TÀI KHOẢN & DỮ LIỆU
============================================================ */
function renderAccount(){
  const lastBackup = getLastBackupAt();
  const totalSessions = Object.values(state.sessionsByClass).reduce((a,b)=>a+(b?b.length:0),0);
  const totalStudents = state.classes.reduce((a,c)=>a+c.students.length,0);
  return `
    <div class="topbar">
      <div><h1 class="page-title">Tài khoản & dữ liệu</h1>${chalkUnderline()}<div class="page-sub">Đồng bộ, sao lưu và bảo mật tài khoản</div></div>
    </div>

    <div class="grid-3" style="margin-bottom:18px;">
      <div class="stat-box"><div class="stat-num">${state.classes.length}</div><div class="stat-label">Lớp học</div></div>
      <div class="stat-box"><div class="stat-num">${totalStudents}</div><div class="stat-label">Học sinh</div></div>
      <div class="stat-box"><div class="stat-num">${totalSessions}</div><div class="stat-label">Buổi học đã ghi</div></div>
    </div>

    <div class="card">
      <div class="card-title">☁️ Đồng bộ</div>
      ${cloudEnabled() ? `
        <div class="row-info"><span class="muted">Đăng nhập với ID</span><b>${esc(displayIdOf(state.user))}</b></div>
        <div class="row-info"><span class="muted">Trạng thái</span><span data-sync-pill class="sync-pill"></span></div>
        <div class="tiny" style="margin:10px 0 14px;line-height:1.6;">Dữ liệu lưu ngay trên thiết bị này để mở nhanh và dùng được khi mất mạng; khi có mạng sẽ tự đồng bộ lên đám mây. Đăng nhập cùng ID trên điện thoại/máy tính khác để dùng chung dữ liệu.</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="btn btn-outline btn-sm" data-action="resync">🔄 Đồng bộ lại ngay</button>
          <button class="btn btn-outline btn-sm" data-action="change-password">🔑 Đổi mật khẩu</button>
          <button class="btn btn-danger-outline btn-sm" data-action="logout">Đăng xuất</button>
        </div>
      ` : `
        <div class="notice">💻 App đang chạy chế độ <b>chỉ lưu trên máy này</b> vì chưa điền <code>firebase-config.js</code>. Xem README để bật đăng nhập và đồng bộ.</div>
      `}
    </div>

    <div class="card">
      <div class="card-title">💾 Sao lưu bằng file</div>
      <div class="muted" style="margin-bottom:10px;">Tải toàn bộ lớp, học sinh và buổi học về 1 file .json — nên làm định kỳ. Khôi phục được cả file sao lưu từ bản EduTrack đầy đủ (chỉ lấy phần lớp học và buổi học).</div>
      <div class="tiny" style="margin-bottom:12px;color:${lastBackup?'var(--success)':'var(--late)'};font-weight:700;">${lastBackup ? '✓ Lần sao lưu gần nhất: '+new Date(lastBackup).toLocaleString('vi-VN') : '⚠ Chưa sao lưu lần nào trên máy này'}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button class="btn btn-accent btn-sm" data-action="export-backup">⬇ Xuất file sao lưu</button>
        <button class="btn btn-outline btn-sm" data-action="trigger-backup-import">⬆ Khôi phục từ file</button>
      </div>
    </div>
  `;
}

function logout(){
  const doIt = async ()=>{
    flushPendingSaves();
    try{ await withTimeout(fbDB.waitForPendingWrites(), 6000, null); }catch(e){}
    // Xoá bản đệm của tài khoản trên máy này để máy dùng chung không lộ dữ liệu
    try{
      const p = store.prefix();
      const del = [];
      for(let i=0;i<localStorage.length;i++){ const k = localStorage.key(i); if(k && k.startsWith(p) && !k.endsWith('__lastBackup')) del.push(k); }
      del.forEach(k=>localStorage.removeItem(k));
    }catch(e){}
    await fbAuth.signOut();
    try{ await fbDB.terminate(); await fbDB.clearPersistence(); }catch(e){}
    location.reload();
  };
  if(store.pending > 0 || !navigator.onLine){
    openConfirmModal('Vẫn còn thay đổi CHƯA đồng bộ lên mây (đang ngoại tuyến). Đăng xuất bây giờ có thể mất các thay đổi đó. Vẫn đăng xuất?', true, doIt);
  } else {
    openConfirmModal('Đăng xuất khỏi tài khoản trên máy này? Dữ liệu vẫn an toàn trên đám mây.', false, doIt);
  }
}

function changePassword(){
  openPromptModal('Mật khẩu hiện tại', '', (oldPass)=>{
    if(!oldPass) return;
    setTimeout(()=> openPromptModal('Mật khẩu mới (ít nhất 6 ký tự)', '', async (newPass)=>{
      if(!newPass || newPass.length < 6){ showToast('Mật khẩu mới cần ít nhất 6 ký tự.'); return; }
      try{
        const user = fbAuth.currentUser;
        const cred = firebase.auth.EmailAuthProvider.credential(user.email, oldPass);
        await user.reauthenticateWithCredential(cred);
        await user.updatePassword(newPass);
        showToast('Đã đổi mật khẩu.');
      }catch(err){ showToast(authErrorMessage(err), 4500); }
    }, {password:true, submitLabel:'Đổi mật khẩu'}), 50);
  }, {password:true, submitLabel:'Tiếp tục'});
}

/* ============================================================
   MÀN HÌNH BÁO THIẾU CẤU HÌNH / KHÔNG TẢI ĐƯỢC FIREBASE
   (thay vì lặng lẽ vào chế độ chỉ lưu trên máy)
============================================================ */
const LOCAL_MODE_FLAG = 'eduassistant:allowLocalMode';
function localModeAllowed(){ try{ return localStorage.getItem(LOCAL_MODE_FLAG)==='1'; }catch(e){ return false; } }

function renderSetupIssue(){
  const noConfig = state.setupIssue === 'no-config';
  return `
  <div class="auth-wrap">
    <div class="auth-card">
      <div class="auth-brand">${brandMark()}<div><div class="brand-name">EDU ASSISTANT</div><div class="brand-sub">Sổ tay giáo viên</div></div></div>
      ${noConfig ? `
        <h2>Chưa kết nối tài khoản</h2>
        <p class="muted" style="margin:6px 0 14px;line-height:1.6;">Trang này chưa được điền cấu hình Firebase nên chưa đăng nhập được.</p>
        <div class="notice" style="margin-bottom:16px;">
          <b>Người quản lý trang:</b> mở file <code>firebase-config.js</code> trên GitHub, thay các giá trị <code>YOUR_...</code> bằng cấu hình dự án Firebase (xem README, mục 1–2), rồi đợi 1–2 phút và tải lại trang.
        </div>
        <button class="btn btn-outline auth-submit" id="use-local">Dùng tạm — chỉ lưu trên máy này</button>
        <div class="tiny" style="margin-top:10px;line-height:1.6;">Chế độ tạm không có đăng nhập và không đồng bộ sang máy khác. Dữ liệu vẫn chuyển được sau này bằng file sao lưu.</div>
      ` : `
        <h2>Không tải được hệ thống đăng nhập</h2>
        <p class="muted" style="margin:6px 0 14px;line-height:1.6;">Trình duyệt chưa tải được thư viện Firebase — thường do mất mạng hoặc mạng trường chặn <code>gstatic.com</code>.</p>
        <button class="btn btn-accent auth-submit" id="retry-load">↻ Thử lại</button>
      `}
    </div>
  </div>`;
}
function attachSetupHandlers(){
  const local = document.getElementById('use-local');
  if(local) local.addEventListener('click', ()=>{
    try{ localStorage.setItem(LOCAL_MODE_FLAG,'1'); }catch(e){}
    state.setupIssue = null;
    startSession(null);
  });
  const retry = document.getElementById('retry-load');
  if(retry) retry.addEventListener('click', ()=> location.reload());
}

/* ============================================================
   KHỞI ĐỘNG
============================================================ */
async function startSession(user){
  state.user = user || null;
  state.loaded = false;
  render();
  await store.init(user ? user.uid : null);
  if(!user) setSyncStatus('local');
  loadAll();
  render();
}

(function init(){
  render();
  if(cloudEnabled()){
    fbAuth.onAuthStateChanged(async (user)=>{
      state.authReady = true;
      if(user){ await startSession(user); }
      else { state.user = null; state.loaded = false; render(); }
    });
  } else {
    state.authReady = true;
    if(FIREBASE_CONFIG){
      // Đã điền cấu hình nhưng không tải được thư viện Firebase → báo lỗi, KHÔNG vào chế độ máy này (tránh dữ liệu bị tách đôi)
      state.setupIssue = 'no-sdk';
      render();
    } else if(!localModeAllowed()){
      state.setupIssue = 'no-config';
      render();
    } else {
      startSession(null);
    }
  }
})();

// Service worker: cho phép cài app lên màn hình chính và mở được khi mất mạng.
if('serviceWorker' in navigator && location.protocol !== 'file:'){
  window.addEventListener('load', ()=>{
    navigator.serviceWorker.register('./sw.js').then(reg=>{
      reg.addEventListener('updatefound', ()=>{
        const nw = reg.installing;
        if(!nw) return;
        nw.addEventListener('statechange', ()=>{
          if(nw.state==='installed' && navigator.serviceWorker.controller){
            showToast('Đã có phiên bản mới — tải lại trang để cập nhật.', 6000);
          }
        });
      });
    }).catch(()=>{});
  });
}
