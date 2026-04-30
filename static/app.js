let allTasks = [];
let projects = []; // [{id, label, parent}]
let currentProject = 'all';
let editingTask = null;

const isTouch = !window.matchMedia('(hover: hover)').matches;

// Task drag
let draggedTask = null;
// Project drag-to-reorder
let draggedProject = null;
let dropTargetId = null;
let dropPosition = null; // 'above' | 'below'

const today = new Date().toISOString().split('T')[0];

// ── Collapsed sections ────────────────────────────
const collapsedSections = new Set(JSON.parse(localStorage.getItem('collapsedSections') || '[]'));

function toggleSection(proj) {
  if (collapsedSections.has(proj)) collapsedSections.delete(proj);
  else collapsedSections.add(proj);
  localStorage.setItem('collapsedSections', JSON.stringify([...collapsedSections]));
  renderTasks();
}
const weekStr = (() => { const d = new Date(); d.setDate(d.getDate() + 7); return d.toISOString().split('T')[0]; })();

// ── Helpers ───────────────────────────────────────
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function projectLabel(id) {
  const p = projects.find(p => p.id === id);
  return p ? p.label : id;
}

function taskCount(id) {
  return allTasks.filter(t => t.project === id && !t.done).length;
}

// ── Data ──────────────────────────────────────────
async function fetchAll() {
  [allTasks, projects] = await Promise.all([
    fetch('/api/tasks').then(r => r.json()),
    fetch('/api/projects').then(r => r.json()),
  ]);
  renderNav();
  renderTasks();
  populateProjectSelects();
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

// ── Long press for touch nav actions ──────────────
let longPressTimer = null;

function navLongPressStart(event, id) {
  longPressTimer = setTimeout(() => {
    longPressTimer = null;
    const wrap = document.querySelector(`.nav-item-wrap[data-id="${CSS.escape(id)}"]`);
    if (!wrap) return;
    // close any other open ones
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

// tap outside closes actions
document.addEventListener('touchstart', (e) => {
  if (!e.target.closest('.nav-item-wrap')) {
    document.querySelectorAll('.nav-item-wrap.actions-open').forEach(el => el.classList.remove('actions-open'));
  }
}, { passive: true });

// ── Nav rendering ─────────────────────────────────
function navItemHTML(p) {
  const count = taskCount(p.id);
  const isActive = currentProject === p.id;
  return `
    <div class="nav-item-wrap" data-id="${esc(p.id)}"
      ${isTouch ? '' : 'draggable="true"'}
      ondragstart="projDragStart(event, '${esc(p.id)}')"
      ondragend="projDragEnd(event)"
      ondragover="wrapDragOver(event, '${esc(p.id)}')"
      ondragleave="wrapDragLeave(event)"
      ondrop="wrapDrop(event, '${esc(p.id)}')"
      ontouchstart="navLongPressStart(event, '${esc(p.id)}')"
      ontouchend="navLongPressEnd()"
      ontouchmove="navLongPressEnd()"
    >
      <button class="nav-btn ${isActive ? 'active' : ''}"
        onclick="selectProject('${esc(p.id)}')"
      >
        <span class="drag-handle">⠿</span>
        <span class="nav-dot"></span>
        <span class="nav-label">${esc(p.label)}</span>
        ${count > 0 ? `<span class="nav-count">${count}</span>` : ''}
      </button>
      <div class="nav-actions">
        <button class="nav-action-btn" title="サブカテゴリを追加"
          onclick="event.stopPropagation(); startAddChild('${esc(p.id)}')">+</button>
        <button class="nav-action-btn" title="名前を変更"
          onclick="event.stopPropagation(); startRenameProject('${esc(p.id)}')">✏</button>
        <button class="nav-action-btn danger" title="削除"
          onclick="event.stopPropagation(); confirmDeleteProject('${esc(p.id)}')">✕</button>
      </div>
    </div>`;
}

function renderNav() {
  const nav = document.getElementById('projects-nav');
  const allCount = allTasks.filter(t => !t.done).length;

  const childrenOf = {};
  for (const p of projects) {
    if (p.parent) (childrenOf[p.parent] = childrenOf[p.parent] || []).push(p);
  }
  const roots = projects.filter(p => !p.parent);

  const todayCount = allTasks.filter(t => !t.done && t.due === today).length;
  const weekCount = allTasks.filter(t => !t.done && t.due && t.due >= today && t.due <= weekStr).length;

  let html = `
  <button class="nav-due-btn ${currentProject === 'due-today' ? 'active' : ''}" onclick="selectProject('due-today')">
    <span class="nav-due-icon">◷</span>
    <span style="flex:1">今日締め切り</span>
    ${todayCount > 0 ? `<span class="nav-count due-urgent">${todayCount}</span>` : ''}
  </button>
  <button class="nav-due-btn ${currentProject === 'due-week' ? 'active' : ''}" onclick="selectProject('due-week')">
    <span class="nav-due-icon">◻</span>
    <span style="flex:1">1週間以内締め切り</span>
    ${weekCount > 0 ? `<span class="nav-count">${weekCount}</span>` : ''}
  </button>
  <div class="nav-divider"></div>
  <button class="nav-all-btn ${currentProject === 'all' ? 'active' : ''}" onclick="selectProject('all')">
    <span style="flex:1">すべて</span>
    ${allCount > 0 ? `<span class="nav-count">${allCount}</span>` : ''}
  </button>`;

  for (const p of roots) {
    const children = childrenOf[p.id] || [];
    if (children.length > 0) {
      html += `<div class="nav-parent">`;
      html += navItemHTML(p);
      html += `<div class="nav-children">`;
      for (const child of children) html += navItemHTML(child);
      html += `</div></div>`;
    } else {
      html += navItemHTML(p);
    }
  }

  html += `<div class="nav-divider"></div>
    <button class="nav-add-btn" onclick="startAddProject()">＋ カテゴリを追加</button>
    <input id="nav-project-input" class="nav-inline-input hidden" placeholder="カテゴリ名"
      onkeydown="handleProjectKey(event)">`;

  nav.innerHTML = html;
}

function selectProject(p) {
  currentProject = p;
  const titleMap = { all: 'すべて', 'due-today': '今日締め切り', 'due-week': '1週間以内締め切り' };
  document.getElementById('main-title').textContent = titleMap[p] ?? projectLabel(p);
  renderNav();
  renderTasks();
  closeSidebar();
}

// ── Project CRUD ──────────────────────────────────
function startAddProject() {
  const input = document.getElementById('nav-project-input');
  input.classList.remove('hidden');
  input.dataset.mode = 'root';
  input.dataset.parentId = '';
  input.value = '';
  input.focus();
}

function startAddChild(parentId) {
  // Insert inline input after parent wrap
  const wrap = document.querySelector(`.nav-item-wrap[data-id="${CSS.escape(parentId)}"]`);
  if (!wrap) return;
  let input = document.getElementById('nav-inline-child-input');
  if (!input) {
    input = document.createElement('input');
    input.id = 'nav-inline-child-input';
    input.className = 'nav-inline-input';
    input.placeholder = 'サブカテゴリ名';
    input.onkeydown = (e) => {
      if (e.isComposing) return;
      if (e.key === 'Enter') submitAddChild(input.dataset.parentId, input.value.trim());
      if (e.key === 'Escape') input.remove();
    };
    input.onblur = () => setTimeout(() => input.remove(), 150);
  }
  input.dataset.parentId = parentId;
  input.value = '';
  // Insert inside nav-children of parent, or after wrap
  const childrenDiv = wrap.closest('.nav-parent')?.querySelector('.nav-children');
  if (childrenDiv) {
    childrenDiv.appendChild(input);
  } else {
    wrap.insertAdjacentElement('afterend', input);
  }
  input.focus();
}

async function submitAddChild(parentId, name) {
  if (!name) return;
  await fetch('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, label: name, parent: parentId }),
  });
  await fetchAll();
}

function handleProjectKey(event) {
  if (event.isComposing) return;
  const input = event.target;
  if (event.key === 'Enter') {
    const name = input.value.trim();
    if (name) submitAddRootProject(name);
    input.classList.add('hidden');
  }
  if (event.key === 'Escape') input.classList.add('hidden');
}

async function submitAddRootProject(name) {
  const res = await fetch('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, label: name }),
  });
  const data = await res.json();
  await fetchAll();
  selectProject(data.name);
}

function startRenameProject(id) {
  const wrap = document.querySelector(`.nav-item-wrap[data-id="${CSS.escape(id)}"]`);
  if (!wrap) return;
  const btn = wrap.querySelector('.nav-btn');
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
      await fetch(`/api/projects/${encodeURIComponent(id)}`, {
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

async function confirmDeleteProject(id) {
  const label = projectLabel(id);
  if (!confirm(`"${label}" を削除しますか？\n未完了タスクはInboxへ移動されます。`)) return;
  await fetch(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (currentProject === id) currentProject = 'all';
  await fetchAll();
}

// ── Project drag-to-reorder ───────────────────────
function projDragStart(event, id) {
  draggedProject = id;
  draggedTask = null;
  event.dataTransfer.effectAllowed = 'move';
}

function projDragEnd(event) {
  draggedProject = null;
  dropTargetId = null;
  dropPosition = null;
  document.querySelectorAll('.nav-item-wrap').forEach(el => {
    el.classList.remove('proj-drag-over-above', 'proj-drag-over-below');
  });
  document.querySelectorAll('.nav-btn').forEach(el => {
    el.classList.remove('task-drag-over');
  });
}

// ── Unified wrap drag handlers ────────────────────
// nav-itemのwrap全体でproject並び替えとtask移動を両方捌く

function wrapDragOver(event, id) {
  event.preventDefault();
  const wrap = event.currentTarget;

  if (draggedTask) {
    // タスクをこのプロジェクトにドロップしようとしている
    document.querySelectorAll('.nav-item-wrap').forEach(el => {
      el.classList.remove('proj-drag-over-above', 'proj-drag-over-below');
      el.querySelector('.nav-btn')?.classList.remove('task-drag-over');
    });
    wrap.querySelector('.nav-btn')?.classList.add('task-drag-over');
  } else if (draggedProject && draggedProject !== id) {
    // プロジェクトの並び替え
    document.querySelectorAll('.nav-item-wrap').forEach(el => {
      el.classList.remove('proj-drag-over-above', 'proj-drag-over-below');
      el.querySelector('.nav-btn')?.classList.remove('task-drag-over');
    });
    const rect = wrap.getBoundingClientRect();
    const pos = event.clientY < rect.top + rect.height / 2 ? 'above' : 'below';
    wrap.classList.add(pos === 'above' ? 'proj-drag-over-above' : 'proj-drag-over-below');
    dropTargetId = id;
    dropPosition = pos;
  }
}

function wrapDragLeave(event) {
  const wrap = event.currentTarget;
  // relatedTarget が wrap の内側なら無視
  if (wrap.contains(event.relatedTarget)) return;
  wrap.classList.remove('proj-drag-over-above', 'proj-drag-over-below');
  wrap.querySelector('.nav-btn')?.classList.remove('task-drag-over');
}

async function wrapDrop(event, targetId) {
  event.preventDefault();
  document.querySelectorAll('.nav-item-wrap').forEach(el => {
    el.classList.remove('proj-drag-over-above', 'proj-drag-over-below');
    el.querySelector('.nav-btn')?.classList.remove('task-drag-over');
  });

  if (draggedTask) {
    // タスクをプロジェクトに移動
    if (draggedTask.project !== targetId) {
      await fetch(`/api/tasks/${draggedTask.project}/${draggedTask.line}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: targetId }),
      });
    }
    draggedTask = null;
    await fetchAll();
  } else if (draggedProject && draggedProject !== targetId) {
    // プロジェクトの並び替え
    const src = projects.find(p => p.id === draggedProject);
    if (!src) return;
    const newOrder = projects.filter(p => p.id !== draggedProject);
    const targetIdx = newOrder.findIndex(p => p.id === targetId);
    if (targetIdx === -1) return;
    const insertAt = dropPosition === 'above' ? targetIdx : targetIdx + 1;
    newOrder.splice(insertAt, 0, src);
    await fetch('/api/projects', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newOrder),
    });
    draggedProject = null;
    await fetchAll();
  }
}

// ── Task rendering ─────────────────────────────────
function renderTasks() {
  const list = document.getElementById('task-list');
  const tasks = currentProject === 'all'
    ? allTasks
    : currentProject === 'due-today'
      ? allTasks.filter(t => !t.done && t.due === today)
      : currentProject === 'due-week'
        ? allTasks.filter(t => !t.done && t.due && t.due >= today && t.due <= weekStr)
        : allTasks.filter(t => t.project === currentProject);

  const open = tasks.filter(t => !t.done);
  const done = tasks.filter(t => t.done);

  if (open.length === 0 && done.length === 0) {
    list.innerHTML = '<div class="empty">タスクなし</div>';
    return;
  }

  let html = '';

  if (currentProject === 'all' || currentProject === 'due-today' || currentProject === 'due-week') {
    const sorted = currentProject.startsWith('due-') ? [...open].sort((a, b) => (a.due || '').localeCompare(b.due || '')) : open;
    const byProject = {};
    for (const t of sorted) (byProject[t.project] = byProject[t.project] || []).push(t);
    for (const [proj, pts] of Object.entries(byProject)) {
      const collapsed = collapsedSections.has(proj);
      html += `<div class="section-title collapsible ${collapsed ? 'collapsed' : ''}" onclick="toggleSection('${esc(proj)}')">
        <span class="section-chevron">${collapsed ? '▶' : '▼'}</span>
        ${esc(projectLabel(proj))}
        <span class="section-count">${pts.length}</span>
      </div>`;
      if (!collapsed) html += pts.map(taskHTML).join('');
    }
  } else {
    html += open.length
      ? open.map(taskHTML).join('')
      : '<div class="empty" style="padding:16px 0">未完了タスクなし</div>';
  }

  if (done.length) {
    html += `<div class="section-title" style="margin-top:24px">完了済み (${done.length})</div>`;
    html += done.map(taskHTML).join('');
  }

  list.innerHTML = html;
}

function taskHTML(t) {
  const overdue = t.due && t.due < today && !t.done;
  const cls = ['task-item', t.done ? 'done' : '', overdue ? 'overdue' : ''].filter(Boolean).join(' ');
  const checkCls = ['task-check', t.done ? 'checked' : ''].filter(Boolean).join(' ');
  const taskJson = JSON.stringify(t).replace(/"/g, '&quot;');

  return `<div class="${cls}"
    ${isTouch ? '' : 'draggable="true"'}
    ondragstart="taskDragStart(event, ${taskJson})"
    ondragend="taskDragEnd(event)"
    onclick="openEditModal(${taskJson})"
  >
    <div class="${checkCls}" onclick="event.stopPropagation(); toggleDone('${t.project}', ${t.line}, ${t.done})"></div>
    <span class="task-name ${t.done ? 'done' : ''}">${esc(t.name)}</span>
    <div class="task-meta">
      ${t.due ? `<span class="due ${overdue ? 'overdue' : ''}">${t.due}</span>` : ''}
      ${t.priority ? `<span class="badge ${t.priority}">${t.priority}</span>` : ''}
    </div>
  </div>`;
}

// ── Task drag ─────────────────────────────────────
function taskDragStart(event, task) {
  draggedTask = task;
  event.dataTransfer.setData('drag-type', 'task');
  event.dataTransfer.effectAllowed = 'move';
  setTimeout(() => {
    const el = event.target.closest('.task-item');
    if (el) el.classList.add('dragging');
  }, 0);
}

function taskDragEnd(event) {
  draggedTask = null;
  document.querySelectorAll('.task-item.dragging').forEach(el => el.classList.remove('dragging'));
}

// ── Toggle done ───────────────────────────────────
async function toggleDone(project, line, currentDone) {
  await fetch(`/api/tasks/${project}/${line}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ done: !currentDone }),
  });
  await fetchAll();
}

// ── Add task modal ────────────────────────────────
function openAddModal() {
  document.getElementById('new-name').value = '';
  document.getElementById('new-priority').value = '';
  document.getElementById('new-due').value = '';
  const sel = document.getElementById('new-project');
  const specialViews = new Set(['all', 'due-today', 'due-week']);
  sel.value = specialViews.has(currentProject) ? 'inbox' : currentProject;
  document.getElementById('modal').classList.remove('hidden');
  setTimeout(() => document.getElementById('new-name').focus(), 50);
}

function closeModal() {
  document.getElementById('modal').classList.add('hidden');
}

async function addTask() {
  const name = document.getElementById('new-name').value.trim();
  if (!name) return;
  await fetch('/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      project: document.getElementById('new-project').value || 'inbox',
      priority: document.getElementById('new-priority').value || null,
      due: document.getElementById('new-due').value || null,
    }),
  });
  closeModal();
  await fetchAll();
}

// ── Edit task modal ───────────────────────────────
function openEditModal(t) {
  editingTask = t;
  document.getElementById('edit-name').value = t.name;
  document.getElementById('edit-priority').value = t.priority || '';
  document.getElementById('edit-due').value = t.due || '';
  document.getElementById('edit-project').value = t.project;
  document.getElementById('edit-modal').classList.remove('hidden');
  setTimeout(() => document.getElementById('edit-name').focus(), 50);
}

function closeEditModal() {
  document.getElementById('edit-modal').classList.add('hidden');
  editingTask = null;
}

async function saveEdit() {
  if (!editingTask) return;
  const newProject = document.getElementById('edit-project').value;
  await fetch(`/api/tasks/${editingTask.project}/${editingTask.line}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: document.getElementById('edit-name').value.trim(),
      priority: document.getElementById('edit-priority').value || null,
      due: document.getElementById('edit-due').value || null,
      project: newProject !== editingTask.project ? newProject : undefined,
    }),
  });
  closeEditModal();
  await fetchAll();
}

async function deleteCurrentTask() {
  if (!editingTask) return;
  if (!confirm(`"${editingTask.name}" を削除しますか？`)) return;
  await fetch(`/api/tasks/${editingTask.project}/${editingTask.line}`, { method: 'DELETE' });
  closeEditModal();
  await fetchAll();
}

// ── Selects ───────────────────────────────────────
function populateProjectSelects() {
  ['new-project', 'edit-project'].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const current = sel.value;
    sel.innerHTML = projects.map(p => `<option value="${p.id}">${esc(p.label)}</option>`).join('');
    if (current) sel.value = current;
  });
}

// ── Keyboard shortcuts ────────────────────────────
document.addEventListener('keydown', e => {
  if (e.isComposing) return;
  const inInput = ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName);
  if (e.key === 'Escape') { closeModal(); closeEditModal(); }
  if (e.key === 'Enter' && !document.getElementById('modal').classList.contains('hidden')) addTask();
  if (e.key === 'Enter' && !document.getElementById('edit-modal').classList.contains('hidden')) saveEdit();
  if (e.key === 'n' && !inInput) openAddModal();
});

// ── Sidebar toggle (mobile) ───────────────────────
function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('sidebar-overlay').classList.toggle('open');
}

function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('open');
}

fetchAll();
