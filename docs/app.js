// ──────────────────────────────────────────────────
// app.js — UI for NEO TODO (GitHub Pages edition)
// ──────────────────────────────────────────────────
import {
  getToken, setToken, clearToken, verifyToken,
  loadAll, getTasks, getTags,
  createTask, updateTask, deleteTask, reorderTasks,
  createTag, updateTag, deleteTag, reorderTagsConfig,
} from './gh.js?v=2';

// ── State ────────────────────────────────────────
let allTasks = [];
let allTags = [];
let currentView = 'all';
let currentSort = localStorage.getItem('neoTodoSort') || 'manual';
let editingTask = null;
let draggedLine = null;
let touchState = null;
let focusedIndex = 0;

const isTouch = !window.matchMedia('(hover: hover)').matches;
const today = new Date().toISOString().split('T')[0];
const weekStr = (() => { const d = new Date(); d.setDate(d.getDate() + 7); return d.toISOString().split('T')[0]; })();

// ── Helpers ──────────────────────────────────────
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function tagLabel(id) {
  const t = allTags.find(t => t.id === id);
  return t ? t.label : id;
}
function tagCount(id) {
  return allTasks.filter(t => !t.done && !t.pending_delete && t.tags.includes(id)).length;
}
function untaggedCount() {
  return allTasks.filter(t => !t.done && !t.pending_delete && t.tags.length === 0).length;
}

// ── Settings (PAT) modal ─────────────────────────
function showSettingsModal(initialError) {
  const modal = document.getElementById('settings-modal');
  const errEl = document.getElementById('settings-error');
  const input = document.getElementById('settings-token');
  errEl.textContent = initialError || '';
  input.value = getToken() || '';
  modal.classList.remove('hidden');
  setTimeout(() => input.focus(), 50);
}
function hideSettingsModal() {
  document.getElementById('settings-modal').classList.add('hidden');
}
async function saveSettings() {
  const tok = document.getElementById('settings-token').value.trim();
  const errEl = document.getElementById('settings-error');
  if (!tok) { errEl.textContent = 'PAT を入力してください'; return; }
  errEl.textContent = '検証中...';
  try {
    const ok = await verifyToken(tok);
    if (!ok) { errEl.textContent = 'PAT が無効です（401/403）'; return; }
    setToken(tok);
    hideSettingsModal();
    await fetchAll();
  } catch (e) {
    errEl.textContent = `エラー: ${e.message}`;
  }
}
function logoutSettings() {
  if (!confirm('PAT を削除しますか？')) return;
  clearToken();
  showSettingsModal('PAT を削除しました');
}
window.openSettings = () => showSettingsModal();
window.saveSettings = saveSettings;
window.logoutSettings = logoutSettings;

// ── Loading indicator ────────────────────────────
let busyDepth = 0;
function setBusy(b) {
  busyDepth = Math.max(0, busyDepth + (b ? 1 : -1));
  document.body.classList.toggle('busy', busyDepth > 0);
}

// ── Data fetch ───────────────────────────────────
async function fetchAll() {
  if (!getToken()) {
    showSettingsModal('まず PAT を入力してください');
    return;
  }
  setBusy(true);
  try {
    const data = await loadAll();
    allTasks = data.tasks;
    allTags = data.tags;
    renderNav();
    renderTasks();
  } catch (e) {
    if (e.message === 'PAT_INVALID') {
      showSettingsModal('PAT が無効です。再入力してください');
    } else {
      console.error(e);
      alert(`データ取得失敗: ${e.message}`);
    }
  } finally {
    setBusy(false);
  }
}

async function withWrite(fn) {
  setBusy(true);
  try {
    await fn();
    await refreshLocal();
  } catch (e) {
    if (e.message === 'PAT_INVALID') {
      showSettingsModal('PAT が無効です');
    } else if (e.message === 'CONFLICT_REFRESH') {
      alert('GitHub 側で変更がありました。再取得します');
      await fetchAll();
    } else {
      console.error(e);
      alert(`保存失敗: ${e.message}`);
    }
  } finally {
    setBusy(false);
  }
}
async function refreshLocal() {
  // After a write, refresh local state without full UI flash
  allTasks = getTasks();
  allTags = getTags();
  renderNav();
  renderTasks();
}

// ── Long-press for nav actions ───────────────────
let longPressTimer = null;
function navLongPressStart(event, id) {
  longPressTimer = setTimeout(() => {
    longPressTimer = null;
    const wrap = document.querySelector(`.nav-item-wrap[data-id="${CSS.escape(id)}"]`);
    if (!wrap) return;
    document.querySelectorAll('.nav-item-wrap.actions-open').forEach(el => {
      if (el !== wrap) el.classList.remove('actions-open');
    });
    wrap.classList.toggle('actions-open');
  }, 500);
}
function navLongPressEnd() {
  clearTimeout(longPressTimer);
  longPressTimer = null;
}
document.addEventListener('touchstart', (e) => {
  if (!e.target.closest('.nav-item-wrap')) {
    document.querySelectorAll('.nav-item-wrap.actions-open').forEach(el => el.classList.remove('actions-open'));
  }
}, { passive: true });
window.navLongPressStart = navLongPressStart;
window.navLongPressEnd = navLongPressEnd;

// ── Sidebar rendering ────────────────────────────
function tagItemHTML(tag) {
  const count = tagCount(tag.id);
  const isActive = currentView === tag.id;
  const cls = ['nav-tag-btn', isActive ? 'active' : ''].filter(Boolean).join(' ');
  return `
    <div class="nav-item-wrap" data-id="${esc(tag.id)}"
      ontouchstart="navLongPressStart(event, '${esc(tag.id)}')"
      ontouchend="navLongPressEnd()"
      ontouchmove="navLongPressEnd()"
    >
      <button class="${cls}" onclick="selectView('${esc(tag.id)}')">
        <span class="tag-hash">#</span><span class="nav-label">${esc(tag.label)}</span>
        ${count > 0 ? `<span class="nav-count">${count}</span>` : ''}
      </button>
      <div class="nav-actions">
        <button class="nav-action-btn" title="名前を変更"
          onclick="event.stopPropagation(); startRenameTag('${esc(tag.id)}')">✏</button>
        <button class="nav-action-btn danger" title="削除"
          onclick="event.stopPropagation(); confirmDeleteTag('${esc(tag.id)}')">✕</button>
      </div>
    </div>`;
}

function renderNav() {
  const nav = document.getElementById('tags-nav');
  const allOpen = allTasks.filter(t => !t.done && !t.pending_delete).length;
  const todayCount = allTasks.filter(t => !t.done && !t.pending_delete && t.due === today).length;
  const weekCount = allTasks.filter(t => !t.done && !t.pending_delete && t.due && t.due >= today && t.due <= weekStr).length;
  const untag = untaggedCount();

  let html = `
  <button class="nav-due-btn ${currentView === 'due-today' ? 'active' : ''}" onclick="selectView('due-today')">
    <span class="nav-due-icon">◷</span>
    <span style="flex:1">今日締め切り</span>
    ${todayCount > 0 ? `<span class="nav-count due-urgent">${todayCount}</span>` : ''}
  </button>
  <button class="nav-due-btn ${currentView === 'due-week' ? 'active' : ''}" onclick="selectView('due-week')">
    <span class="nav-due-icon">◻</span>
    <span style="flex:1">1週間以内</span>
    ${weekCount > 0 ? `<span class="nav-count">${weekCount}</span>` : ''}
  </button>
  <div class="nav-divider"></div>
  <button class="nav-all-btn ${currentView === 'all' ? 'active' : ''}" onclick="selectView('all')">
    <span style="flex:1">すべて</span>
    ${allOpen > 0 ? `<span class="nav-count">${allOpen}</span>` : ''}
  </button>
  <button class="nav-all-btn ${currentView === 'untagged' ? 'active' : ''}" onclick="selectView('untagged')">
    <span style="flex:1; color:var(--muted)">タグなし</span>
    ${untag > 0 ? `<span class="nav-count">${untag}</span>` : ''}
  </button>
  <div class="nav-section-label">タグ</div>`;

  for (const tag of allTags) html += tagItemHTML(tag);

  html += `<div class="nav-divider"></div>
    <button class="nav-add-btn" onclick="startAddTag()">＋ タグを追加</button>
    <input id="nav-tag-input" class="nav-inline-input hidden" placeholder="タグ名"
      onkeydown="handleTagKey(event)">
    <div class="nav-divider"></div>
    <button class="nav-add-btn" onclick="openSettings()">⚙ 設定 (PAT)</button>`;

  nav.innerHTML = html;
}

function selectView(v) {
  currentView = v;
  const titleMap = { all: 'すべて', 'due-today': '今日締め切り', 'due-week': '1週間以内', untagged: 'タグなし' };
  let title = titleMap[v];
  if (!title) title = `#${tagLabel(v)}`;
  document.getElementById('main-title').textContent = title;
  renderNav();
  renderTasks();
  closeSidebar();
}
window.selectView = selectView;

// ── Tag CRUD wrappers ────────────────────────────
function startAddTag() {
  const input = document.getElementById('nav-tag-input');
  input.classList.remove('hidden');
  input.value = '';
  input.focus();
}
window.startAddTag = startAddTag;

function handleTagKey(event) {
  if (event.isComposing) return;
  const input = event.target;
  if (event.key === 'Enter') {
    const name = input.value.trim().replace(/^#/, '');
    if (name) submitAddTag(name);
    input.classList.add('hidden');
  }
  if (event.key === 'Escape') input.classList.add('hidden');
}
window.handleTagKey = handleTagKey;

async function submitAddTag(name) {
  await withWrite(() => createTag(name, name));
}

function startRenameTag(id) {
  const wrap = document.querySelector(`.nav-item-wrap[data-id="${CSS.escape(id)}"]`);
  if (!wrap) return;
  const btn = wrap.querySelector('.nav-tag-btn');
  const label = btn.querySelector('.nav-label');
  const currentName = label.textContent;
  const input = document.createElement('input');
  input.className = 'nav-inline-input';
  input.value = currentName;
  input.style.margin = '2px 4px';
  wrap.replaceWith(input);
  input.focus();
  input.select();
  const commit = async () => {
    const newLabel = input.value.trim();
    if (newLabel && newLabel !== currentName) {
      await withWrite(() => updateTag(id, { label: newLabel }));
    } else {
      await fetchAll();
    }
  };
  input.onkeydown = (e) => {
    if (e.isComposing) return;
    if (e.key === 'Enter') commit();
    if (e.key === 'Escape') fetchAll();
  };
  input.onblur = commit;
}
window.startRenameTag = startRenameTag;

async function confirmDeleteTag(id) {
  const lbl = tagLabel(id);
  if (!confirm(`タグ "#${lbl}" を削除しますか？\nこのタグはタスクから取り除かれます。`)) return;
  await withWrite(() => deleteTag(id));
  if (currentView === id) currentView = 'all';
  renderNav();
  renderTasks();
}
window.confirmDeleteTag = confirmDeleteTag;

// ── Sort ─────────────────────────────────────────
function setSort(mode) {
  currentSort = mode;
  localStorage.setItem('neoTodoSort', mode);
  renderTasks();
  renderSortBar();
}
window.setSort = setSort;
function renderSortBar() {
  document.querySelectorAll('.sort-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.sort === currentSort);
  });
}
const PRIORITY_ORDER = { P1: 1, P2: 2, P3: 3, P4: 4 };
const priorityRank = (p) => PRIORITY_ORDER[p] || 99;
function applySort(tasks, mode) {
  const arr = [...tasks];
  if (mode === 'due') {
    arr.sort((a, b) => (a.due || '￿').localeCompare(b.due || '￿'));
  } else if (mode === 'priority') {
    arr.sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority));
  } else if (mode === 'tag') {
    arr.sort((a, b) => (a.tags[0] || '￿').localeCompare(b.tags[0] || '￿'));
  } else if (mode === 'added') {
    arr.sort((a, b) => (a.created || '').localeCompare(b.created || ''));
  }
  return arr;
}

// ── Task list rendering ──────────────────────────
function renderTasks() {
  const list = document.getElementById('task-list');
  let filtered;
  if (currentView === 'all') filtered = allTasks;
  else if (currentView === 'untagged') filtered = allTasks.filter(t => t.tags.length === 0);
  else if (currentView === 'due-today') filtered = allTasks.filter(t => !t.done && t.due === today);
  else if (currentView === 'due-week') filtered = allTasks.filter(t => !t.done && t.due && t.due >= today && t.due <= weekStr);
  else filtered = allTasks.filter(t => t.tags.includes(currentView));

  let open = filtered.filter(t => !t.done);
  const effective = (currentView === 'due-today' || currentView === 'due-week') ? 'due' : currentSort;
  open = applySort(open, effective);
  open.sort((a, b) => (a.pending_delete === b.pending_delete) ? 0 : (a.pending_delete ? 1 : -1));

  if (open.length === 0) {
    list.innerHTML = '<div class="empty">タスクなし</div>';
    return;
  }

  let html = '';
  if (effective === 'tag') {
    const groups = {};
    const order = [];
    for (const t of open) {
      const key = t.tags[0] || '__untagged';
      if (!(key in groups)) { groups[key] = []; order.push(key); }
      groups[key].push(t);
    }
    for (const key of order) {
      const lbl = key === '__untagged' ? 'タグなし' : `#${tagLabel(key)}`;
      html += `<div class="section-title"><span style="flex:1">${esc(lbl)}</span><span class="section-count">${groups[key].length}</span></div>`;
      html += groups[key].map(taskHTML).join('');
    }
  } else {
    html = open.map(taskHTML).join('');
  }
  list.innerHTML = html;
  applyFocus();
}

function tagPillHTML(tagId) {
  const lbl = tagLabel(tagId);
  return `<span class="tag-pill" onclick="event.stopPropagation(); selectView('${esc(tagId)}')">
    <span class="hash">#</span>${esc(lbl)}
  </span>`;
}

function taskHTML(t) {
  const overdue = t.due && t.due < today && !t.pending_delete;
  const cls = ['task-item',
    overdue ? 'overdue' : '',
    t.pending_delete ? 'pending-delete' : '',
  ].filter(Boolean).join(' ');
  const checkCls = ['task-check', t.pending_delete ? 'checked' : ''].filter(Boolean).join(' ');
  const taskJson = JSON.stringify(t).replace(/"/g, '&quot;');
  const tagPills = t.tags.map(tagPillHTML).join('');
  const actions = t.pending_delete
    ? `<button class="task-action-btn danger" onclick="event.stopPropagation(); finalDelete(${t.line})" title="完全に削除">🗑</button>`
    : '';
  const effectiveSort = (currentView === 'due-today' || currentView === 'due-week') ? 'due' : currentSort;
  const dragEnabled = effectiveSort === 'manual';
  const html5Drag = !isTouch && dragEnabled;
  const dragHandle = dragEnabled ? `<span class="task-drag-handle" title="ドラッグで並び替え">⠿</span>` : '';
  const dragAttrs = html5Drag
    ? `draggable="true"
       ondragstart="taskDragStart(event, ${t.line})"
       ondragend="taskDragEnd(event)"
       ondragover="taskDragOver(event, ${t.line})"
       ondragleave="taskDragLeave(event)"
       ondrop="taskDrop(event, ${t.line})"`
    : '';
  const touchAttrs = (isTouch && dragEnabled) ? `ontouchstart="taskTouchStart(event, ${t.line})"` : '';
  return `<div class="${cls}" data-line="${t.line}"
    ${dragAttrs}
    ${touchAttrs}
    onclick="openEditModal(${taskJson})"
  >
    ${dragHandle}
    <div class="${checkCls}" onclick="event.stopPropagation(); togglePendingDelete(${t.line}, ${t.pending_delete})" title="${t.pending_delete ? 'チェックを外す' : 'チェック → 削除候補に'}"></div>
    <div class="task-body">
      <span class="task-name">${esc(t.name)}</span>
      ${tagPills ? `<div class="task-tags">${tagPills}</div>` : ''}
    </div>
    <div class="task-meta">
      ${t.due ? `<span class="due ${overdue ? 'overdue' : ''}">${t.due}</span>` : ''}
      ${t.priority ? `<span class="badge ${t.priority}">${t.priority}</span>` : ''}
    </div>
    <div class="task-actions">${actions}</div>
  </div>`;
}

// ── Drag & drop (HTML5) ──────────────────────────
function taskDragStart(event, line) {
  draggedLine = line;
  event.dataTransfer.effectAllowed = 'move';
  try { event.dataTransfer.setData('text/plain', String(line)); } catch (_) {}
  setTimeout(() => {
    const el = event.target.closest('.task-item');
    if (el) el.classList.add('dragging');
  }, 0);
}
function taskDragEnd() {
  draggedLine = null;
  document.querySelectorAll('.task-item.dragging').forEach(el => el.classList.remove('dragging'));
  document.querySelectorAll('.task-item.drag-over-above, .task-item.drag-over-below').forEach(el => el.classList.remove('drag-over-above', 'drag-over-below'));
}
function taskDragOver(event, line) {
  if (draggedLine == null) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  if (draggedLine === line) return;
  const el = event.currentTarget;
  document.querySelectorAll('.task-item.drag-over-above, .task-item.drag-over-below').forEach(x => x.classList.remove('drag-over-above', 'drag-over-below'));
  const rect = el.getBoundingClientRect();
  const above = event.clientY < rect.top + rect.height / 2;
  el.classList.add(above ? 'drag-over-above' : 'drag-over-below');
}
function taskDragLeave(event) {
  const el = event.currentTarget;
  if (el.contains(event.relatedTarget)) return;
  el.classList.remove('drag-over-above', 'drag-over-below');
}
async function taskDrop(event, targetLine) {
  event.preventDefault();
  const movedLine = draggedLine;
  if (movedLine == null || movedLine === targetLine) { taskDragEnd(); return; }
  const targetEl = event.currentTarget;
  const rect = targetEl.getBoundingClientRect();
  const above = event.clientY < rect.top + rect.height / 2;
  taskDragEnd();
  await commitReorder(movedLine, targetLine, above);
}
window.taskDragStart = taskDragStart;
window.taskDragEnd = taskDragEnd;
window.taskDragOver = taskDragOver;
window.taskDragLeave = taskDragLeave;
window.taskDrop = taskDrop;

// ── Touch drag ───────────────────────────────────
function taskTouchStart(event, line) {
  if (event.touches.length !== 1) return;
  const effective = (currentView === 'due-today' || currentView === 'due-week') ? 'due' : currentSort;
  if (effective !== 'manual') return;
  const touch = event.touches[0];
  const el = event.currentTarget;
  if (!el) return;
  const handleMove = (e) => taskTouchMove(e);
  const handleEnd = (e) => taskTouchEnd(e);
  touchState = {
    line, startX: touch.clientX, startY: touch.clientY, el,
    active: false, suppressClick: false,
    longPressTimer: setTimeout(() => {
      if (!touchState) return;
      touchState.active = true;
      touchState.suppressClick = true;
      el.classList.add('dragging');
      if (navigator.vibrate) { try { navigator.vibrate(30); } catch (_) {} }
    }, 350),
    handleMove, handleEnd,
  };
  document.addEventListener('touchmove', handleMove, { passive: false });
  document.addEventListener('touchend', handleEnd);
  document.addEventListener('touchcancel', handleEnd);
}
function taskTouchMove(event) {
  if (!touchState) return;
  if (event.touches.length !== 1) { cancelTouchDrag(); return; }
  const touch = event.touches[0];
  const dy = Math.abs(touch.clientY - touchState.startY);
  const dx = Math.abs(touch.clientX - touchState.startX);
  if (!touchState.active) {
    if (dy > 8 || dx > 8) cancelTouchDrag();
    return;
  }
  event.preventDefault();
  const targetEl = document.elementFromPoint(touch.clientX, touch.clientY);
  const targetItem = targetEl && targetEl.closest('.task-item');
  document.querySelectorAll('.task-item.drag-over-above, .task-item.drag-over-below').forEach(x => x.classList.remove('drag-over-above', 'drag-over-below'));
  if (targetItem && parseInt(targetItem.dataset.line, 10) !== touchState.line) {
    const rect = targetItem.getBoundingClientRect();
    const above = touch.clientY < rect.top + rect.height / 2;
    targetItem.classList.add(above ? 'drag-over-above' : 'drag-over-below');
  }
}
async function taskTouchEnd(event) {
  if (!touchState) return;
  if (touchState.longPressTimer) clearTimeout(touchState.longPressTimer);
  document.removeEventListener('touchmove', touchState.handleMove);
  document.removeEventListener('touchend', touchState.handleEnd);
  document.removeEventListener('touchcancel', touchState.handleEnd);
  const wasActive = touchState.active;
  const movedLine = touchState.line;
  const sourceEl = touchState.el;
  const suppressClick = touchState.suppressClick;
  touchState = null;
  if (sourceEl) sourceEl.classList.remove('dragging');
  document.querySelectorAll('.task-item.drag-over-above, .task-item.drag-over-below').forEach(x => x.classList.remove('drag-over-above', 'drag-over-below'));
  if (suppressClick) {
    const blocker = (e) => { e.stopPropagation(); e.preventDefault(); };
    document.addEventListener('click', blocker, { capture: true, once: true });
  }
  if (!wasActive) return;
  const touch = event.changedTouches && event.changedTouches[0];
  if (!touch) return;
  const targetEl = document.elementFromPoint(touch.clientX, touch.clientY);
  const targetItem = targetEl && targetEl.closest('.task-item');
  if (!targetItem) return;
  const targetLine = parseInt(targetItem.dataset.line, 10);
  if (targetLine === movedLine) return;
  const rect = targetItem.getBoundingClientRect();
  const above = touch.clientY < rect.top + rect.height / 2;
  await commitReorder(movedLine, targetLine, above);
}
function cancelTouchDrag() {
  if (!touchState) return;
  if (touchState.longPressTimer) clearTimeout(touchState.longPressTimer);
  document.removeEventListener('touchmove', touchState.handleMove);
  document.removeEventListener('touchend', touchState.handleEnd);
  document.removeEventListener('touchcancel', touchState.handleEnd);
  if (touchState.el) touchState.el.classList.remove('dragging');
  touchState = null;
}
window.taskTouchStart = taskTouchStart;

async function commitReorder(movedLine, targetLine, above) {
  const visibleEls = Array.from(document.querySelectorAll('#task-list .task-item'));
  const visibleLines = visibleEls.map(el => parseInt(el.dataset.line, 10));
  const newVisible = visibleLines.filter(l => l !== movedLine);
  const targetIdx = newVisible.indexOf(targetLine);
  newVisible.splice(above ? targetIdx : targetIdx + 1, 0, movedLine);
  const visibleSet = new Set(visibleLines);
  const globalLines = allTasks.map(t => t.line);
  let cursor = 0;
  const newGlobal = globalLines.map(ln => visibleSet.has(ln) ? newVisible[cursor++] : ln);
  await withWrite(() => reorderTasks(newGlobal));
}

// ── Done toggles & delete ────────────────────────
async function togglePendingDelete(line, currentlyPending) {
  await withWrite(() => updateTask(line, { pending_delete: !currentlyPending }));
}
async function finalDelete(line) {
  await withWrite(() => deleteTask(line));
}
window.togglePendingDelete = togglePendingDelete;
window.finalDelete = finalDelete;

// ── Tag picker (chips in modals) ─────────────────
let newTaskTags = [];
let editTaskTags = [];

function renderTagPicker(prefix, selectedTags) {
  const chipsEl = document.getElementById(`${prefix}-tags-chips`);
  const knownIds = new Set(allTags.map(t => t.id));
  const allIds = new Set([...knownIds, ...selectedTags]);
  const list = [...allIds].map(id => {
    const found = allTags.find(t => t.id === id);
    return { id, label: found ? found.label : id };
  });
  list.sort((a, b) => {
    const aSel = selectedTags.includes(a.id);
    const bSel = selectedTags.includes(b.id);
    if (aSel !== bSel) return aSel ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
  chipsEl.innerHTML = list.map(tag => {
    const isSelected = selectedTags.includes(tag.id);
    return `<button class="tag-chip ${isSelected ? 'selected' : ''}" type="button" data-tag-id="${esc(tag.id)}">
      <span class="hash">#</span>${esc(tag.label)}
    </button>`;
  }).join('');
  chipsEl.querySelectorAll('.tag-chip').forEach(el => {
    el.onclick = (e) => {
      e.preventDefault();
      const tid = el.dataset.tagId;
      const idx = selectedTags.indexOf(tid);
      if (idx >= 0) selectedTags.splice(idx, 1);
      else selectedTags.push(tid);
      renderTagPicker(prefix, selectedTags);
    };
  });
  const input = document.getElementById(`${prefix}-tag-input`);
  input.onkeydown = (e) => {
    if (e.isComposing) return;
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const name = input.value.trim().replace(/^#/, '').replace(/[\s,]+/g, '');
      if (name && !selectedTags.includes(name)) {
        selectedTags.push(name);
        renderTagPicker(prefix, selectedTags);
      }
      input.value = '';
    }
  };
}

// ── Add task modal ───────────────────────────────
function openAddModal() {
  document.getElementById('new-name').value = '';
  document.getElementById('new-priority').value = '';
  document.getElementById('new-due').value = '';
  document.getElementById('new-tag-input').value = '';
  const isViewTag = !['all', 'due-today', 'due-week', 'untagged'].includes(currentView);
  newTaskTags = isViewTag ? [currentView] : [];
  renderTagPicker('new', newTaskTags);
  document.getElementById('modal').classList.remove('hidden');
  setTimeout(() => document.getElementById('new-name').focus(), 50);
}
function closeModal() { document.getElementById('modal').classList.add('hidden'); }
async function addTask() {
  const name = document.getElementById('new-name').value.trim();
  if (!name) return;
  const tags = [...newTaskTags];
  const priority = document.getElementById('new-priority').value || null;
  const due = document.getElementById('new-due').value || null;
  closeModal();
  await withWrite(() => createTask({ name, tags, priority, due }));
}
window.openAddModal = openAddModal;
window.closeModal = closeModal;
window.addTask = addTask;

// ── Edit task modal ──────────────────────────────
function openEditModal(t) {
  editingTask = t;
  document.getElementById('edit-name').value = t.name;
  document.getElementById('edit-priority').value = t.priority || '';
  document.getElementById('edit-due').value = t.due || '';
  document.getElementById('edit-tag-input').value = '';
  editTaskTags = [...(t.tags || [])];
  renderTagPicker('edit', editTaskTags);
  document.getElementById('edit-modal').classList.remove('hidden');
  setTimeout(() => document.getElementById('edit-name').focus(), 50);
}
function closeEditModal() {
  document.getElementById('edit-modal').classList.add('hidden');
  editingTask = null;
}
async function saveEdit() {
  if (!editingTask) return;
  const line = editingTask.line;
  const updates = {
    name: document.getElementById('edit-name').value.trim(),
    tags: [...editTaskTags],
    priority: document.getElementById('edit-priority').value || null,
    due: document.getElementById('edit-due').value || null,
  };
  closeEditModal();
  await withWrite(() => updateTask(line, updates));
}
window.openEditModal = openEditModal;
window.closeEditModal = closeEditModal;
window.saveEdit = saveEdit;

// ── vi-style focus ───────────────────────────────
function visibleTaskItems() { return Array.from(document.querySelectorAll('#task-list .task-item')); }
function applyFocus() {
  const items = visibleTaskItems();
  document.querySelectorAll('.task-item.focused').forEach(el => el.classList.remove('focused'));
  if (items.length === 0) return;
  if (focusedIndex < 0) focusedIndex = 0;
  if (focusedIndex >= items.length) focusedIndex = items.length - 1;
  const el = items[focusedIndex];
  el.classList.add('focused');
  el.scrollIntoView({ block: 'nearest' });
}
function moveFocus(delta) {
  const items = visibleTaskItems();
  if (items.length === 0) return;
  focusedIndex = Math.max(0, Math.min(items.length - 1, focusedIndex + delta));
  applyFocus();
}
function focusedTask() {
  const items = visibleTaskItems();
  const el = items[focusedIndex];
  if (!el) return null;
  const ln = parseInt(el.dataset.line, 10);
  return allTasks.find(t => t.line === ln) || null;
}

// ── Keyboard shortcuts ───────────────────────────
document.addEventListener('keydown', e => {
  if (e.isComposing) return;
  const inInput = ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName);
  const modalOpen = !document.getElementById('modal').classList.contains('hidden');
  const editOpen = !document.getElementById('edit-modal').classList.contains('hidden');
  const settingsOpen = !document.getElementById('settings-modal').classList.contains('hidden');
  if (e.key === 'Escape') { closeModal(); closeEditModal(); hideSettingsModal(); return; }
  if (e.key === 'Enter' && modalOpen) { addTask(); return; }
  if (e.key === 'Enter' && editOpen) { saveEdit(); return; }
  if (e.key === 'Enter' && settingsOpen) { saveSettings(); return; }
  if (inInput || modalOpen || editOpen || settingsOpen) return;
  if (e.key === 'j') { moveFocus(1); e.preventDefault(); return; }
  if (e.key === 'k') { moveFocus(-1); e.preventDefault(); return; }
  if (e.key === 'g') { focusedIndex = 0; applyFocus(); e.preventDefault(); return; }
  if (e.key === 'G') { focusedIndex = visibleTaskItems().length - 1; applyFocus(); e.preventDefault(); return; }
  if (e.key === 'x') {
    const t = focusedTask();
    if (t) togglePendingDelete(t.line, t.pending_delete);
    e.preventDefault();
    return;
  }
  if (e.key === 'Enter') {
    const t = focusedTask();
    if (t) openEditModal(t);
    e.preventDefault();
    return;
  }
  if (e.key === 'n') openAddModal();
});

// ── Sidebar toggle (mobile) ──────────────────────
function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('sidebar-overlay').classList.toggle('open');
}
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('open');
}
window.toggleSidebar = toggleSidebar;
window.closeSidebar = closeSidebar;

// ── Init ─────────────────────────────────────────
renderSortBar();
fetchAll();
