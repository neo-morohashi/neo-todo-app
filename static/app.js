let allTasks = [];
let projects = [];
let currentProject = 'all';
let editingTask = null;
let draggedTask = null;

const today = new Date().toISOString().split('T')[0];

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

// ── Nav ───────────────────────────────────────────
function renderNav() {
  const nav = document.getElementById('projects-nav');

  const allCount = allTasks.filter(t => !t.done).length;
  const tabs = [
    { key: 'all', label: 'すべて', count: allCount },
    ...projects.map(p => ({
      key: p,
      label: p,
      count: allTasks.filter(t => t.project === p && !t.done).length,
    })),
  ];

  const buttonsHTML = tabs.map(({ key, label, count }) => `
    <button
      class="nav-btn ${currentProject === key ? 'active' : ''}"
      onclick="selectProject('${key}')"
      ondragover="navDragOver(event, '${key}')"
      ondragleave="navDragLeave(event)"
      ondrop="navDrop(event, '${key}')"
      data-project="${key}"
    >${label}<span class="nav-count">${count}</span></button>
  `).join('');

  nav.innerHTML = `
    ${buttonsHTML}
    <div class="nav-divider"></div>
    <button class="nav-add-btn" onclick="startAddProject()" title="カテゴリを追加">＋</button>
    <input id="nav-project-input" class="nav-input hidden" placeholder="カテゴリ名"
      onblur="cancelAddProject()"
      onkeydown="handleProjectKey(event)">
  `;
}

function selectProject(p) {
  currentProject = p;
  renderNav();
  renderTasks();
}

// ── Task rendering ─────────────────────────────────
function renderTasks() {
  const list = document.getElementById('task-list');
  let tasks = currentProject === 'all'
    ? allTasks
    : allTasks.filter(t => t.project === currentProject);

  const open = tasks.filter(t => !t.done);
  const done = tasks.filter(t => t.done);

  if (open.length === 0 && done.length === 0) {
    list.innerHTML = '<div class="empty">タスクなし</div>';
    return;
  }

  let html = '';

  if (currentProject === 'all') {
    const byProject = {};
    for (const t of open) {
      (byProject[t.project] = byProject[t.project] || []).push(t);
    }
    for (const [proj, pts] of Object.entries(byProject)) {
      html += `<div class="section-title">${proj}</div>`;
      html += pts.map(taskHTML).join('');
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

  return `
    <div class="${cls}"
      draggable="true"
      ondragstart="taskDragStart(event, ${taskJson})"
      ondragend="taskDragEnd(event)"
      onclick="openEditModal(${taskJson})"
    >
      <div class="${checkCls}"
        onclick="event.stopPropagation(); toggleDone('${t.project}', ${t.line}, ${t.done})"
      ></div>
      <span class="task-name ${t.done ? 'done' : ''}">${esc(t.name)}</span>
      <div class="task-meta">
        ${t.due ? `<span class="due ${overdue ? 'overdue' : ''}">${t.due}</span>` : ''}
        ${t.priority ? `<span class="badge ${t.priority}">${t.priority}</span>` : ''}
      </div>
    </div>`;
}

function esc(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Toggle done ────────────────────────────────────
async function toggleDone(project, line, currentDone) {
  await fetch(`/api/tasks/${project}/${line}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ done: !currentDone }),
  });
  await fetchAll();
}

// ── Drag & Drop ────────────────────────────────────
function taskDragStart(event, task) {
  draggedTask = task;
  event.dataTransfer.effectAllowed = 'move';
  // Mark as dragging after a tick so the item shows before fading
  setTimeout(() => {
    const el = event.target.closest('.task-item');
    if (el) el.classList.add('dragging');
  }, 0);
}

function taskDragEnd(event) {
  draggedTask = null;
  document.querySelectorAll('.task-item.dragging').forEach(el => el.classList.remove('dragging'));
}

function navDragOver(event, project) {
  if (!draggedTask) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  event.currentTarget.classList.add('drag-over');
}

function navDragLeave(event) {
  event.currentTarget.classList.remove('drag-over');
}

async function navDrop(event, targetProject) {
  event.currentTarget.classList.remove('drag-over');
  if (!draggedTask) return;
  if (draggedTask.project === targetProject) return;
  if (targetProject === 'all') return;

  await fetch(`/api/tasks/${draggedTask.project}/${draggedTask.line}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project: targetProject }),
  });
  draggedTask = null;
  await fetchAll();
}

// ── Add project ────────────────────────────────────
function startAddProject() {
  const input = document.getElementById('nav-project-input');
  input.classList.remove('hidden');
  input.value = '';
  input.focus();
}

function cancelAddProject() {
  const input = document.getElementById('nav-project-input');
  if (input) input.classList.add('hidden');
}

function handleProjectKey(event) {
  if (event.key === 'Enter') submitAddProject();
  if (event.key === 'Escape') cancelAddProject();
}

async function submitAddProject() {
  const input = document.getElementById('nav-project-input');
  const name = input.value.trim();
  if (!name) { cancelAddProject(); return; }
  const res = await fetch('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const data = await res.json();
  cancelAddProject();
  await fetchAll();
  selectProject(data.name);
}

// ── Add task modal ─────────────────────────────────
function openAddModal() {
  document.getElementById('new-name').value = '';
  document.getElementById('new-priority').value = '';
  document.getElementById('new-due').value = '';
  const sel = document.getElementById('new-project');
  sel.value = currentProject !== 'all' ? currentProject : 'inbox';
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

// ── Edit task modal ────────────────────────────────
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

// ── Selects ────────────────────────────────────────
function populateProjectSelects() {
  ['new-project', 'edit-project'].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const current = sel.value;
    sel.innerHTML = projects.map(p => `<option value="${p}">${p}</option>`).join('');
    if (current) sel.value = current;
  });
}

// ── Keyboard shortcuts ─────────────────────────────
document.addEventListener('keydown', e => {
  const inInput = ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName);
  if (e.key === 'Escape') { closeModal(); closeEditModal(); cancelAddProject(); }
  if (e.key === 'Enter' && !document.getElementById('modal').classList.contains('hidden')) addTask();
  if (e.key === 'Enter' && !document.getElementById('edit-modal').classList.contains('hidden')) saveEdit();
  if (e.key === 'n' && !inInput) openAddModal();
});

fetchAll();
