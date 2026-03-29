let allTasks = [];
let projects = [];
let currentProject = 'all';
let editingTask = null;

const today = new Date().toISOString().split('T')[0];

async function fetchAll() {
  [allTasks, projects] = await Promise.all([
    fetch('/api/tasks').then(r => r.json()),
    fetch('/api/projects').then(r => r.json()),
  ]);
  renderNav();
  renderTasks();
  populateProjectSelects();
}

function renderNav() {
  const nav = document.getElementById('projects-nav');
  const all = ['all', ...projects];
  nav.innerHTML = all.map(p => {
    const count = p === 'all'
      ? allTasks.filter(t => !t.done).length
      : allTasks.filter(t => t.project === p && !t.done).length;
    const label = p === 'all' ? 'すべて' : p;
    return `<button class="nav-btn ${currentProject === p ? 'active' : ''}" onclick="selectProject('${p}')">${label} <span style="opacity:0.6">${count}</span></button>`;
  }).join('');
}

function selectProject(p) {
  currentProject = p;
  renderNav();
  renderTasks();
}

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

  // Group open tasks by project (only in 'all' view)
  if (currentProject === 'all') {
    const byProject = {};
    for (const t of open) {
      if (!byProject[t.project]) byProject[t.project] = [];
      byProject[t.project].push(t);
    }
    for (const [proj, pts] of Object.entries(byProject)) {
      html += `<div class="section-title">${proj}</div>`;
      html += pts.map(taskHTML).join('');
    }
  } else {
    if (open.length) html += open.map(taskHTML).join('');
    else html += '<div class="empty" style="padding:16px 0">未完了タスクなし</div>';
  }

  if (done.length) {
    html += `<div class="section-title" style="margin-top:24px">完了済み (${done.length})</div>`;
    html += done.map(taskHTML).join('');
  }

  list.innerHTML = html;
}

function taskHTML(t) {
  const overdue = t.due && t.due < today && !t.done;
  const classes = ['task-item', t.done ? 'done' : '', overdue ? 'overdue' : ''].filter(Boolean).join(' ');
  const checkClass = ['task-check', t.done ? 'checked' : ''].filter(Boolean).join(' ');

  const dueLabel = t.due
    ? `<span class="due ${overdue ? 'overdue' : ''}">${t.due}</span>`
    : '';
  const priBadge = t.priority
    ? `<span class="badge ${t.priority}">${t.priority}</span>`
    : '';

  return `
    <div class="${classes}" onclick="openEditModal(${JSON.stringify(t).replace(/"/g, '&quot;')})">
      <div class="${checkClass}" onclick="event.stopPropagation(); toggleDone('${t.project}', ${t.line}, ${t.done})"></div>
      <span class="task-name ${t.done ? 'done' : ''}">${escHtml(t.name)}</span>
      <div class="task-meta">${dueLabel}${priBadge}</div>
    </div>`;
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

async function toggleDone(project, line, currentDone) {
  await fetch(`/api/tasks/${project}/${line}`, {
    method: 'PATCH',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ done: !currentDone }),
  });
  await fetchAll();
}

// Add modal
function openAddModal() {
  document.getElementById('new-name').value = '';
  document.getElementById('new-priority').value = '';
  document.getElementById('new-due').value = '';
  document.getElementById('new-project').value = 'inbox';
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
    headers: {'Content-Type': 'application/json'},
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

// Edit modal
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
    headers: {'Content-Type': 'application/json'},
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
  await fetch(`/api/tasks/${editingTask.project}/${editingTask.line}`, {
    method: 'DELETE',
  });
  closeEditModal();
  await fetchAll();
}

function populateProjectSelects() {
  ['new-project', 'edit-project'].forEach(id => {
    const sel = document.getElementById(id);
    const current = sel.value;
    sel.innerHTML = projects.map(p => `<option value="${p}">${p}</option>`).join('');
    if (current) sel.value = current;
  });
}

// Keyboard shortcuts
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeModal(); closeEditModal(); }
  if (e.key === 'Enter' && !document.getElementById('modal').classList.contains('hidden')) addTask();
  if (e.key === 'Enter' && !document.getElementById('edit-modal').classList.contains('hidden')) saveEdit();
  if (e.key === 'n' && document.activeElement.tagName !== 'INPUT') openAddModal();
});

fetchAll();
