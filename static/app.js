// ── State ────────────────────────────────────────
let allTasks = [];
let allTags = []; // [{id, label, parent}]
let currentView = 'all'; // 'all' | 'due-today' | 'due-week' | 'untagged' | tag id
let currentSort = localStorage.getItem('neoTodoSort') || 'manual'; // 'manual' | 'due' | 'priority' | 'tag'
let editingTask = null;

// Drag state
let draggedLine = null;

// vi-style keyboard focus
let focusedIndex = 0;

const isTouch = !window.matchMedia('(hover: hover)').matches;

const today = new Date().toISOString().split('T')[0];
const weekStr = (() => { const d = new Date(); d.setDate(d.getDate() + 7); return d.toISOString().split('T')[0]; })();

// ── Helpers ───────────────────────────────────────
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function tagLabel(id) {
  const t = allTags.find(t => t.id === id);
  return t ? t.label : id;
}

function tagCount(id) {
  return allTasks.filter(t => !t.done && !t.pending_delete &&
    t.tags.includes(id)).length;
}

function untaggedCount() {
  return allTasks.filter(t => !t.done && !t.pending_delete && t.tags.length === 0).length;
}

// ── Data ──────────────────────────────────────────
async function fetchAll() {
  [allTasks, allTags] = await Promise.all([
    fetch('/api/tasks').then(r => r.json()),
    fetch('/api/tags').then(r => r.json()),
  ]);
  renderNav();
  renderTasks();
}

async function fetchTunnelUrl() {
  try {
    const { url } = await fetch('/api/tunnel-url').then(r => r.json());
    const el = document.getElementById('tunnel-url');
    if (url) {
      el.href = url;
      el.textContent = url.replace('https://', '');
      el.classList.remove('hidden');
    }
  } catch {}
}
setTimeout(fetchTunnelUrl, 3000);
setInterval(fetchTunnelUrl, 30000);

// ── Long-press for nav actions (touch) ────────────
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

  for (const tag of allTags) {
    html += tagItemHTML(tag);
  }

  html += `<div class="nav-divider"></div>
    <button class="nav-add-btn" onclick="startAddTag()">＋ タグを追加</button>
    <input id="nav-tag-input" class="nav-inline-input hidden" placeholder="タグ名"
      onkeydown="handleTagKey(event)">`;

  nav.innerHTML = html;
}

function selectView(v) {
  currentView = v;
  const titleMap = {
    all: 'すべて',
    'due-today': '今日締め切り',
    'due-week': '1週間以内',
    'untagged': 'タグなし',
  };
  let title = titleMap[v];
  if (!title) {
    const lbl = tagLabel(v);
    title = `#${lbl}`;
  }
  document.getElementById('main-title').textContent = title;
  renderNav();
  renderTasks();
  closeSidebar();
}

// ── Tag CRUD ──────────────────────────────────────
function startAddTag() {
  const input = document.getElementById('nav-tag-input');
  input.classList.remove('hidden');
  input.value = '';
  input.focus();
}

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

async function submitAddTag(name) {
  await fetch('/api/tags', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, label: name }),
  });
  await fetchAll();
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
      await fetch(`/api/tags/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: newLabel }),
      });
    }
    await fetchAll();
  };

  input.onkeydown = (e) => {
    if (e.isComposing) return;
    if (e.key === 'Enter') commit();
    if (e.key === 'Escape') fetchAll();
  };
  input.onblur = commit;
}

async function confirmDeleteTag(id) {
  const lbl = tagLabel(id);
  if (!confirm(`タグ "#${lbl}" を削除しますか？\nこのタグはタスクから取り除かれます（タスク自体は残ります）。`)) return;
  await fetch(`/api/tags/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (currentView === id) currentView = 'all';
  await fetchAll();
}

// ── Sort ─────────────────────────────────────────
function setSort(mode) {
  currentSort = mode;
  localStorage.setItem('neoTodoSort', mode);
  renderTasks();
  renderSortBar();
}

function renderSortBar() {
  document.querySelectorAll('.sort-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.sort === currentSort);
  });
}

const PRIORITY_ORDER = { 'P1': 1, 'P2': 2, 'P3': 3, 'P4': 4 };
function priorityRank(p) { return PRIORITY_ORDER[p] || 99; }

function applySort(tasks, mode) {
  const arr = [...tasks];
  if (mode === 'due') {
    arr.sort((a, b) => {
      const ad = a.due || '￿';
      const bd = b.due || '￿';
      return ad.localeCompare(bd);
    });
  } else if (mode === 'priority') {
    arr.sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority));
  } else if (mode === 'tag') {
    arr.sort((a, b) => {
      const at = a.tags[0] || '￿';
      const bt = b.tags[0] || '￿';
      return at.localeCompare(bt);
    });
  } else if (mode === 'added') {
    // Tasks without `created` (legacy) come first, then ascending by created
    arr.sort((a, b) => {
      const ac = a.created || '';
      const bc = b.created || '';
      return ac.localeCompare(bc);
    });
  }
  // 'manual': no sort (keep file order)
  return arr;
}

// ── Task list rendering ──────────────────────────
function renderTasks() {
  const list = document.getElementById('task-list');

  let filtered;
  if (currentView === 'all') {
    filtered = allTasks;
  } else if (currentView === 'untagged') {
    filtered = allTasks.filter(t => t.tags.length === 0);
  } else if (currentView === 'due-today') {
    filtered = allTasks.filter(t => !t.done && t.due === today);
  } else if (currentView === 'due-week') {
    filtered = allTasks.filter(t => !t.done && t.due && t.due >= today && t.due <= weekStr);
  } else {
    filtered = allTasks.filter(t => t.tags.includes(currentView));
  }

  let open = filtered.filter(t => !t.done);
  // Effective sort: due-today/due-week always due-sorted; otherwise use currentSort
  const effective = (currentView === 'due-today' || currentView === 'due-week') ? 'due' : currentSort;
  open = applySort(open, effective);
  // pending_delete always at bottom
  open.sort((a, b) => (a.pending_delete === b.pending_delete) ? 0 : (a.pending_delete ? 1 : -1));

  if (open.length === 0) {
    list.innerHTML = '<div class="empty">タスクなし</div>';
    return;
  }

  let html = '';
  if (effective === 'tag') {
    // Group by first tag
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
  const dragEnabled = !isTouch && effectiveSort === 'manual';
  const dragHandle = dragEnabled
    ? `<span class="task-drag-handle" title="ドラッグで並び替え">⠿</span>`
    : '';

  return `<div class="${cls}" data-line="${t.line}"
    ${dragEnabled ? 'draggable="true"' : ''}
    ondragstart="taskDragStart(event, ${t.line})"
    ondragend="taskDragEnd(event)"
    ondragover="taskDragOver(event, ${t.line})"
    ondragleave="taskDragLeave(event)"
    ondrop="taskDrop(event, ${t.line})"
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

// ── Drag & drop reorder ──────────────────────────
function taskDragStart(event, line) {
  draggedLine = line;
  event.dataTransfer.effectAllowed = 'move';
  // setData is required by Firefox for drag to initiate
  try { event.dataTransfer.setData('text/plain', String(line)); } catch (_) {}
  setTimeout(() => {
    const el = event.target.closest('.task-item');
    if (el) el.classList.add('dragging');
  }, 0);
}

function taskDragEnd(event) {
  draggedLine = null;
  document.querySelectorAll('.task-item.dragging').forEach(el => el.classList.remove('dragging'));
  document.querySelectorAll('.task-item.drag-over-above, .task-item.drag-over-below').forEach(el => {
    el.classList.remove('drag-over-above', 'drag-over-below');
  });
}

function taskDragOver(event, line) {
  if (draggedLine == null) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  if (draggedLine === line) return;
  const el = event.currentTarget;
  document.querySelectorAll('.task-item.drag-over-above, .task-item.drag-over-below').forEach(x => {
    x.classList.remove('drag-over-above', 'drag-over-below');
  });
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
  // Capture before taskDragEnd clears the global
  const movedLine = draggedLine;
  if (movedLine == null || movedLine === targetLine) {
    taskDragEnd(event);
    return;
  }

  const targetEl = event.currentTarget;
  const rect = targetEl.getBoundingClientRect();
  const above = event.clientY < rect.top + rect.height / 2;
  taskDragEnd(event);

  // Build the visible-order array (currently rendered tasks, in display order)
  const visibleEls = Array.from(document.querySelectorAll('#task-list .task-item'));
  const visibleLines = visibleEls.map(el => parseInt(el.dataset.line, 10));

  // Remove dragged from visible, insert at target position
  const newVisible = visibleLines.filter(l => l !== movedLine);
  const targetIdx = newVisible.indexOf(targetLine);
  newVisible.splice(above ? targetIdx : targetIdx + 1, 0, movedLine);

  // Map back to global order: walk allTasks (file order), replace each visible line
  // anchor with the next entry from newVisible
  const visibleSet = new Set(visibleLines);
  const globalLines = allTasks.map(t => t.line);
  let cursor = 0;
  const newGlobal = globalLines.map(ln => {
    if (visibleSet.has(ln)) {
      return newVisible[cursor++];
    }
    return ln;
  });

  await fetch('/api/tasks/order', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ order: newGlobal }),
  });
  await fetchAll();
}

// ── 2-step delete via checkbox ──────────────────
async function togglePendingDelete(line, currentlyPending) {
  await fetch(`/api/tasks/${line}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pending_delete: !currentlyPending }),
  });
  await fetchAll();
}

async function finalDelete(line) {
  await fetch(`/api/tasks/${line}`, { method: 'DELETE' });
  await fetchAll();
}

// ── Add task modal ───────────────────────────────
function tagsFromString(s) {
  const matches = (s || '').match(/#?([\w\-]+)/gu) || [];
  return Array.from(new Set(matches.map(m => m.replace(/^#/, '').trim()).filter(Boolean)));
}

function renderTagsPreview(previewId, tags) {
  const el = document.getElementById(previewId);
  el.innerHTML = tags.map(t => `<span class="tag-pill"><span class="hash">#</span>${esc(t)}</span>`).join('');
}

function bindTagInput(inputId, previewId) {
  const input = document.getElementById(inputId);
  const update = () => renderTagsPreview(previewId, tagsFromString(input.value));
  input.oninput = update;
  return update;
}

function openAddModal() {
  document.getElementById('new-name').value = '';
  document.getElementById('new-priority').value = '';
  document.getElementById('new-due').value = '';

  // Prefill tag input with the current view if it's a tag
  const isViewTag = !['all', 'due-today', 'due-week', 'untagged'].includes(currentView);
  document.getElementById('new-tags').value = isViewTag ? `#${currentView}` : '';
  renderTagsPreview('new-tags-preview', tagsFromString(document.getElementById('new-tags').value));
  bindTagInput('new-tags', 'new-tags-preview');

  document.getElementById('modal').classList.remove('hidden');
  setTimeout(() => document.getElementById('new-name').focus(), 50);
}

function closeModal() {
  document.getElementById('modal').classList.add('hidden');
}

async function addTask() {
  const name = document.getElementById('new-name').value.trim();
  if (!name) return;
  const tags = tagsFromString(document.getElementById('new-tags').value);
  await fetch('/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      tags,
      priority: document.getElementById('new-priority').value || null,
      due: document.getElementById('new-due').value || null,
    }),
  });
  closeModal();
  await fetchAll();
}

// ── Edit task modal ──────────────────────────────
function openEditModal(t) {
  editingTask = t;
  document.getElementById('edit-name').value = t.name;
  document.getElementById('edit-priority').value = t.priority || '';
  document.getElementById('edit-due').value = t.due || '';
  document.getElementById('edit-tags').value = (t.tags || []).map(x => `#${x}`).join(' ');
  renderTagsPreview('edit-tags-preview', t.tags || []);
  bindTagInput('edit-tags', 'edit-tags-preview');

  document.getElementById('edit-modal').classList.remove('hidden');
  setTimeout(() => document.getElementById('edit-name').focus(), 50);
}

function closeEditModal() {
  document.getElementById('edit-modal').classList.add('hidden');
  editingTask = null;
}

async function saveEdit() {
  if (!editingTask) return;
  const tags = tagsFromString(document.getElementById('edit-tags').value);
  await fetch(`/api/tasks/${editingTask.line}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: document.getElementById('edit-name').value.trim(),
      tags,
      priority: document.getElementById('edit-priority').value || null,
      due: document.getElementById('edit-due').value || null,
    }),
  });
  closeEditModal();
  await fetchAll();
}

// ── Keyboard shortcuts ───────────────────────────
function visibleTaskItems() {
  return Array.from(document.querySelectorAll('#task-list .task-item'));
}

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

function focusedLine() {
  const items = visibleTaskItems();
  const el = items[focusedIndex];
  if (!el) return null;
  return parseInt(el.dataset.line, 10);
}

function focusedTask() {
  const ln = focusedLine();
  if (ln == null) return null;
  return allTasks.find(t => t.line === ln);
}

document.addEventListener('keydown', e => {
  if (e.isComposing) return;
  const inInput = ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName);
  const modalOpen = !document.getElementById('modal').classList.contains('hidden');
  const editOpen = !document.getElementById('edit-modal').classList.contains('hidden');

  if (e.key === 'Escape') { closeModal(); closeEditModal(); return; }
  if (e.key === 'Enter' && modalOpen) { addTask(); return; }
  if (e.key === 'Enter' && editOpen) { saveEdit(); return; }
  if (inInput || modalOpen || editOpen) return;

  // vi-style navigation (only when not in input/modal)
  if (e.key === 'j') { moveFocus(1); e.preventDefault(); return; }
  if (e.key === 'k') { moveFocus(-1); e.preventDefault(); return; }
  if (e.key === 'g') { focusedIndex = 0; applyFocus(); e.preventDefault(); return; }
  if (e.key === 'G') {
    focusedIndex = visibleTaskItems().length - 1;
    applyFocus();
    e.preventDefault();
    return;
  }
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

renderSortBar();
fetchAll();
