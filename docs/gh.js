// ──────────────────────────────────────────────────
// gh.js — GitHub Contents API data layer for NEO TODO
// Reads/writes `inbox.md`, `archive.md`, `tags.json`
// from a GitHub repo. PAT stored in localStorage.
// ──────────────────────────────────────────────────

const REPO = 'neo-morohashi/neo-todo';
const API_BASE = 'https://api.github.com';
const TOKEN_KEY = 'gh_token';

// ── PAT helpers ──────────────────────────────────
export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}
export function setToken(t) {
  localStorage.setItem(TOKEN_KEY, t);
}
export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}
export async function verifyToken(t) {
  const res = await fetch(`${API_BASE}/repos/${REPO}`, {
    headers: { Authorization: `token ${t}`, Accept: 'application/vnd.github+json' },
  });
  if (res.status === 401 || res.status === 403) return false;
  if (!res.ok) throw new Error(`GitHub: ${res.status}`);
  return true;
}

// ── Base64 ⇄ UTF-8 ─────────────────────────────────
function b64encodeUtf8(str) {
  return btoa(unescape(encodeURIComponent(str)));
}
function b64decodeUtf8(b64) {
  return decodeURIComponent(escape(atob(b64.replace(/\n/g, ''))));
}

// ── File helpers ─────────────────────────────────
async function ghHeaders() {
  return {
    Authorization: `token ${getToken()}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
  };
}

export async function getFile(path) {
  const res = await fetch(`${API_BASE}/repos/${REPO}/contents/${path}`, {
    headers: await ghHeaders(),
  });
  if (res.status === 401) throw new Error('PAT_INVALID');
  if (res.status === 404) return { content: '', sha: null };
  if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
  const data = await res.json();
  return { content: b64decodeUtf8(data.content), sha: data.sha };
}

export async function putFile(path, content, sha, message) {
  const body = {
    message: message || `update ${path}`,
    content: b64encodeUtf8(content),
  };
  if (sha) body.sha = sha;
  const res = await fetch(`${API_BASE}/repos/${REPO}/contents/${path}`, {
    method: 'PUT',
    headers: await ghHeaders(),
    body: JSON.stringify(body),
  });
  if (res.status === 401) throw new Error('PAT_INVALID');
  if (res.status === 409 || res.status === 422) throw new Error('SHA_CONFLICT');
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`PUT ${path}: ${res.status} ${t}`);
  }
  const data = await res.json();
  return { sha: data.content.sha };
}

// ── Task line parsing (mirror main.py) ───────────
const TASK_RE = /^- \[([ x])\] (.+)$/;
const TAG_RE = /#([\w\-]+)/gu;

function parseMeta(metaStr) {
  const meta = {};
  for (let part of metaStr.split('|')) {
    part = part.trim();
    if (/^P[1-4]$/.test(part)) meta.priority = part;
    else if (part.startsWith('due:')) meta.due = part.slice(4);
    else if (part.startsWith('repeat:')) meta.repeat = part.slice(7);
    else if (part.startsWith('completed:')) meta.completed = part.slice(10);
    else if (part.startsWith('created:')) meta.created = part.slice(8);
    else if (part === 'pending_delete:1') meta.pending_delete = true;
  }
  return meta;
}

export function parseTaskLine(line, lineNo) {
  const m = TASK_RE.exec(line);
  if (!m) return null;
  const done = m[1] === 'x';
  const rest = m[2];
  const idx = rest.indexOf('|');
  const nameWithTags = (idx >= 0 ? rest.slice(0, idx) : rest).trimEnd();
  const meta = idx >= 0 ? parseMeta(rest.slice(idx + 1)) : {};
  const tags = [...nameWithTags.matchAll(TAG_RE)].map(x => x[1]);
  const name = nameWithTags.replace(TAG_RE, '').replace(/\s+/g, ' ').trim();
  return {
    id: lineNo,
    line: lineNo,
    name,
    done,
    tags,
    priority: meta.priority || null,
    due: meta.due || null,
    repeat: meta.repeat || null,
    completed: meta.completed || null,
    created: meta.created || null,
    pending_delete: !!meta.pending_delete,
  };
}

export function buildTaskLine(t) {
  const check = t.done ? 'x' : ' ';
  let namePart = (t.name || '').trim();
  if (t.tags && t.tags.length) {
    namePart = namePart + ' ' + t.tags.map(x => `#${x}`).join(' ');
  }
  const parts = [namePart];
  if (t.priority) parts.push(t.priority);
  if (t.due) parts.push(`due:${t.due}`);
  if (t.repeat) parts.push(`repeat:${t.repeat}`);
  if (t.completed) parts.push(`completed:${t.completed}`);
  if (t.created) parts.push(`created:${t.created}`);
  if (t.pending_delete) parts.push('pending_delete:1');
  return `- [${check}] ` + parts.join(' | ');
}

function parseAllTasks(text) {
  const tasks = [];
  text.split('\n').forEach((line, i) => {
    const t = parseTaskLine(line, i);
    if (t) tasks.push(t);
  });
  return tasks;
}

// ── In-memory state ──────────────────────────────
const state = {
  inbox: { content: '', sha: null },
  tags: { content: '', sha: null, list: [] },
  archive: { content: '', sha: null },
};

export async function loadAll() {
  const [inboxFile, tagsFile] = await Promise.all([
    getFile('inbox.md'),
    getFile('tags.json'),
  ]);
  state.inbox = { content: inboxFile.content, sha: inboxFile.sha };
  state.tags = {
    content: tagsFile.content,
    sha: tagsFile.sha,
    list: tagsFile.content ? JSON.parse(tagsFile.content) : [],
  };
  return {
    tasks: parseAllTasks(state.inbox.content),
    tags: tagsWithDiscovered(),
  };
}

export function getTasks() {
  return parseAllTasks(state.inbox.content);
}

function tagsWithDiscovered() {
  const known = new Set(state.tags.list.map(t => t.id));
  const used = new Set();
  for (const t of parseAllTasks(state.inbox.content)) {
    for (const tg of t.tags) used.add(tg);
  }
  const out = [...state.tags.list];
  for (const u of used) {
    if (!known.has(u)) out.push({ id: u, label: u, parent: null });
  }
  return out;
}

export function getTags() {
  return tagsWithDiscovered();
}

// ── Save helpers (rebuild file content from tasks array) ──
function rebuildInbox(tasks) {
  // Preserve the header (lines before the first task line)
  const oldLines = state.inbox.content.split('\n');
  const firstTaskIdx = oldLines.findIndex(l => TASK_RE.test(l));
  let header;
  if (firstTaskIdx >= 0) header = oldLines.slice(0, firstTaskIdx);
  else header = ['# Inbox', ''];
  // Strip trailing blank lines from header (we'll add back blank line)
  while (header.length && header[header.length - 1] === '') header.pop();
  if (header.length && !header[header.length - 1].startsWith('#')) {
    // ensure blank line after heading
  }
  if (header.length) header.push('');

  const newLines = [...header, ...tasks.map(buildTaskLine)];
  return newLines.join('\n') + '\n';
}

async function saveInbox(tasks, message, retry = true) {
  const content = rebuildInbox(tasks);
  try {
    const r = await putFile('inbox.md', content, state.inbox.sha, message);
    state.inbox = { content, sha: r.sha };
  } catch (e) {
    if (e.message === 'SHA_CONFLICT' && retry) {
      // refetch then retry once
      const fresh = await getFile('inbox.md');
      state.inbox = { content: fresh.content, sha: fresh.sha };
      // Rebuild from existing tasks (they may have changed); user will need to retry
      throw new Error('CONFLICT_REFRESH');
    }
    throw e;
  }
}

async function saveTagsConfig(tagsList, message, retry = true) {
  const content = JSON.stringify(tagsList, null, 2);
  try {
    const r = await putFile('tags.json', content, state.tags.sha, message);
    state.tags = { content, sha: r.sha, list: tagsList };
  } catch (e) {
    if (e.message === 'SHA_CONFLICT' && retry) {
      const fresh = await getFile('tags.json');
      state.tags = {
        content: fresh.content,
        sha: fresh.sha,
        list: fresh.content ? JSON.parse(fresh.content) : [],
      };
      throw new Error('CONFLICT_REFRESH');
    }
    throw e;
  }
}

async function appendArchive(taskLine) {
  // Read latest archive, append, write back
  const fresh = await getFile('archive.md');
  let content = fresh.content || '# Archive\n\n';
  if (!content.endsWith('\n')) content += '\n';
  content += taskLine + '\n';
  const r = await putFile('archive.md', content, fresh.sha, 'archive task');
  state.archive = { content, sha: r.sha };
}

// ── CRUD: tasks ──────────────────────────────────
export async function createTask({ name, tags = [], priority = null, due = null }) {
  // Parse inline tags from name; merge
  const inline = [...name.matchAll(TAG_RE)].map(x => x[1]);
  const cleanName = name.replace(TAG_RE, '').replace(/\s+/g, ' ').trim();
  const merged = [...new Set([...tags, ...inline])];
  const created = new Date().toISOString().slice(0, 19);
  const t = {
    name: cleanName,
    tags: merged,
    priority,
    due,
    repeat: null,
    created,
    done: false,
    pending_delete: false,
  };
  const tasks = parseAllTasks(state.inbox.content);
  tasks.push(t);
  await saveInbox(tasks, 'add task');
}

export async function updateTask(line, updates) {
  const tasks = parseAllTasks(state.inbox.content);
  const idx = tasks.findIndex(t => t.line === line);
  if (idx < 0) throw new Error('Task not found');
  const t = tasks[idx];

  // Inline-tag extraction in name updates
  if ('name' in updates) {
    const inline = [...(updates.name || '').matchAll(TAG_RE)].map(x => x[1]);
    updates.name = (updates.name || '').replace(TAG_RE, '').replace(/\s+/g, ' ').trim();
    if ('tags' in updates) {
      updates.tags = [...new Set([...updates.tags, ...inline])];
    } else if (inline.length) {
      updates.tags = [...new Set([...t.tags, ...inline])];
    }
  }

  const wasDone = t.done;
  const newDone = 'done' in updates ? updates.done : wasDone;
  const merged = { ...t, ...updates };

  if (newDone && !wasDone) {
    // archive
    merged.completed = new Date().toISOString().slice(0, 10);
    tasks.splice(idx, 1);
    await saveInbox(tasks, 'complete task');
    await appendArchive(buildTaskLine(merged));
  } else {
    tasks[idx] = merged;
    await saveInbox(tasks, 'update task');
  }
}

export async function deleteTask(line) {
  const tasks = parseAllTasks(state.inbox.content);
  const idx = tasks.findIndex(t => t.line === line);
  if (idx < 0) throw new Error('Task not found');
  tasks.splice(idx, 1);
  await saveInbox(tasks, 'delete task');
}

export async function reorderTasks(newOrderLines) {
  const tasks = parseAllTasks(state.inbox.content);
  const byLine = new Map(tasks.map(t => [t.line, t]));
  const seen = new Set();
  const reordered = [];
  for (const ln of newOrderLines) {
    if (byLine.has(ln) && !seen.has(ln)) {
      reordered.push(byLine.get(ln));
      seen.add(ln);
    }
  }
  for (const t of tasks) {
    if (!seen.has(t.line)) reordered.push(t);
  }
  await saveInbox(reordered, 'reorder tasks');
}

// ── CRUD: tags ───────────────────────────────────
export async function createTag(name, label) {
  const id = name.trim().replace(/[^\w\-ぁ-んァ-ン一-龥]/gu, '-');
  if (!id) throw new Error('Invalid name');
  const list = [...state.tags.list];
  if (!list.some(t => t.id === id)) {
    list.push({ id, label: label || name, parent: null });
    await saveTagsConfig(list, `add tag ${id}`);
  }
  return id;
}

export async function reorderTagsConfig(newConfig) {
  await saveTagsConfig(newConfig, 'reorder tags');
}

export async function updateTag(id, { label, parent }) {
  const list = state.tags.list.map(t => {
    if (t.id !== id) return t;
    return { ...t, ...(label !== undefined ? { label } : {}), ...(parent !== undefined ? { parent: parent || null } : {}) };
  });
  await saveTagsConfig(list, `rename tag ${id}`);
}

export async function deleteTag(id) {
  // Remove from config (re-parent children to null)
  const list = state.tags.list.filter(t => t.id !== id).map(t => {
    if (t.parent === id) return { ...t, parent: null };
    return t;
  });
  await saveTagsConfig(list, `delete tag ${id}`);
  // Strip the tag from all tasks
  const tasks = parseAllTasks(state.inbox.content);
  let changed = false;
  for (const t of tasks) {
    if (t.tags.includes(id)) {
      t.tags = t.tags.filter(x => x !== id);
      changed = true;
    }
  }
  if (changed) {
    await saveInbox(tasks, `strip tag ${id}`);
  }
}
