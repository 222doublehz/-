const $ = (selector) => document.querySelector(selector);
const dropzone = $('#dropzone');
const fileInput = $('#fileInput');
const analyzeBtn = $('#analyzeBtn');
const modal = $('#settingsModal');
let selectedFile = null;

const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024;

function formatBytes(bytes) {
  if (!bytes) return '0 MB';
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function chooseFile(file) {
  if (!file) return;
  if (file.size > MAX_FILE_SIZE) {
    window.alert('文件超过 2GB 限制，请选择更小的视频。');
    return;
  }
  if (file.type && !file.type.startsWith('video/')) {
    window.alert('请选择 MP4、MOV、WEBM 或 MKV 视频文件。');
    return;
  }
  selectedFile = file;
  $('#fileName').textContent = file.name;
  $('#fileSize').textContent = formatBytes(file.size);
  $('#filePreview').classList.remove('hidden');
  dropzone.classList.add('hidden');
  analyzeBtn.disabled = false;
}

$('#browseBtn').onclick = () => fileInput.click();
fileInput.onchange = (event) => chooseFile(event.target.files[0]);
$('#removeFile').onclick = () => {
  selectedFile = null;
  fileInput.value = '';
  $('#filePreview').classList.add('hidden');
  dropzone.classList.remove('hidden');
  analyzeBtn.disabled = true;
};

for (const eventName of ['dragenter', 'dragover']) {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.add('drag');
  });
}
for (const eventName of ['dragleave', 'drop']) {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.remove('drag');
  });
}
dropzone.addEventListener('drop', (event) => chooseFile(event.dataTransfer.files[0]));

function setProgress(title, description, percent) {
  $('#processingTitle').textContent = title;
  $('#processingDesc').textContent = description;
  $('#processingProgress').style.width = `${percent}%`;
  $('#processingPercent').textContent = `${percent}%`;
}

function showProcessing() {
  $('#emptyState').classList.add('hidden');
  $('#resultState').classList.add('hidden');
  $('#processingState').classList.remove('hidden');
  $('#processingProgress').style.background = 'var(--accent)';
  setProgress('正在准备视频…', '上传完成，马上开始处理', 5);
  $('#copyBtn').disabled = true;
  $('#exportBtn').disabled = true;
}

function setAnalysisError(error) {
  $('#processingTitle').textContent = '分析未完成';
  $('#processingDesc').textContent = error.message || '请检查服务端配置和上游接口';
  $('#processingProgress').style.background = 'var(--danger)';
  $('#processingProgress').style.width = '100%';
  $('#processingPercent').textContent = 'ERROR';
}

function appendCase(container, value, index) {
  const item = document.createElement('div');
  item.className = 'case-item';
  const title = document.createElement('b');
  const description = document.createTextNode('');
  if (Array.isArray(value)) {
    title.textContent = String(value[0] || `案例 ${String(index + 1).padStart(2, '0')}`);
    description.textContent = String(value[1] || '');
  } else if (value && typeof value === 'object') {
    title.textContent = String(value.title || value.name || `案例 ${String(index + 1).padStart(2, '0')}`);
    description.textContent = String(value.description || value.content || '');
  } else {
    title.textContent = `案例 ${String(index + 1).padStart(2, '0')}`;
    description.textContent = String(value || '');
  }
  item.append(title, description);
  container.append(item);
}

function formatTimestamp(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const clock = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return hours ? `${String(hours).padStart(2, '0')}:${clock}` : clock;
}

function transcriptRange(segment) {
  const startMs = Number.isFinite(Number(segment?.startMs)) ? Number(segment.startMs) : 0;
  const endMs = Number.isFinite(Number(segment?.endMs)) ? Number(segment.endMs) : null;
  const start = formatTimestamp(startMs);
  return endMs !== null && endMs > startMs ? `${start} – ${formatTimestamp(endMs)}` : start;
}

function transcriptTextForExport() {
  return [...document.querySelectorAll('#transcriptList .transcript-row')]
    .map((row) => `[${row.querySelector('.transcript-time')?.textContent || '00:00'}] ${row.querySelector('p')?.textContent || ''}`)
    .join('\n');
}

function renderTranscript(data) {
  const list = $('#transcriptList');
  const toggle = $('#toggleTranscript');
  const segments = Array.isArray(data.transcriptSegments)
    ? data.transcriptSegments.filter((item) => item && String(item.text || '').trim())
    : [];
  const rows = segments.length ? segments : [{ startMs: 0, endMs: null, text: data.transcript || '暂无文字稿' }];

  list.replaceChildren();
  list.classList.remove('expanded');
  for (const segment of rows) {
    const row = document.createElement('div');
    row.className = 'transcript-row';
    const time = document.createElement('time');
    time.className = 'transcript-time';
    time.textContent = transcriptRange(segment);
    const text = document.createElement('p');
    text.textContent = String(segment.text || '');
    row.append(time, text);
    list.append(row);
  }

  toggle.textContent = '展开全文 ↓';
  requestAnimationFrame(() => {
    toggle.classList.toggle('hidden', list.scrollHeight <= list.clientHeight + 1);
  });
}

function renderResult(data) {
  $('#processingState').classList.add('hidden');
  $('#resultState').classList.remove('hidden');
  $('#copyBtn').disabled = false;
  $('#exportBtn').disabled = false;
  $('#resultTime').textContent = '刚刚';
  $('#outTheme').textContent = data.theme || '未识别主题';

  const points = $('#outPoints');
  points.replaceChildren();
  for (const point of Array.isArray(data.points) ? data.points : []) {
    const item = document.createElement('li');
    item.textContent = String(point);
    points.append(item);
  }

  $('#outSummary').textContent = data.summary || '暂无总结';
  const cases = $('#outCases');
  cases.replaceChildren();
  for (const [index, value] of (Array.isArray(data.cases) ? data.cases : []).entries()) {
    appendCase(cases, value, index);
  }
  renderTranscript(data);
}

async function analyzeViaServer() {
  const query = new URLSearchParams({
    language: $('#language').value,
    style: $('#style').value,
  });
  const response = await fetch(`/api/analyze?${query}`, {
    method: 'POST',
    headers: { 'Content-Type': selectedFile.type || 'application/octet-stream' },
    body: selectedFile,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error([payload.error, payload.detail].filter(Boolean).join('：') || `服务端返回 ${response.status}`);
  }
  return payload;
}

async function getHealth() {
  const response = await fetch('/api/health', { cache: 'no-store' });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `健康检查返回 ${response.status}`);
  return payload;
}

async function runAnalysis() {
  if (!selectedFile || analyzeBtn.disabled) return;
  showProcessing();
  analyzeBtn.disabled = true;
  try {
    setProgress('正在检查服务…', '确认语音和文字模型配置', 8);
    const health = await getHealth();
    if (!health.configured) {
      throw new Error(`服务端配置不完整：${(health.missing || []).join('、') || '请检查 .env'}`);
    }
    setProgress('正在提取音频…', `使用 ${health.transcribeModel} 转写视频声音`, 25);
    const resultPromise = analyzeViaServer();
    setProgress('正在转写和分析…', `先由 ${health.transcribeModel} 转写，再由 ${health.analysisModel} 提炼`, 45);
    const result = await resultPromise;
    setProgress('正在整理输出…', '结构化报告已生成', 100);
    renderResult(result);
  } catch (error) {
    setAnalysisError(error);
  } finally {
    analyzeBtn.disabled = !selectedFile;
  }
}

analyzeBtn.onclick = runAnalysis;
document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && selectedFile && !analyzeBtn.disabled) {
    runAnalysis();
  }
});

async function refreshServiceStatus() {
  const status = $('#serviceStatus');
  if (!status) return;
  status.textContent = '正在读取服务端配置…';
  try {
    const health = await getHealth();
    $('#statusTranscribeModel').textContent = health.transcribeModel || '未配置';
    $('#statusAnalysisModel').textContent = health.analysisModel || '未配置';
    status.textContent = health.configured
      ? '服务已就绪，API Key 保存在服务端 .env。'
      : `服务端配置不完整：${(health.missing || []).join('、')}`;
    status.classList.toggle('is-error', !health.configured);
  } catch (error) {
    status.textContent = error.message || '无法连接本地服务';
    status.classList.add('is-error');
  }
}

$('#openSettings').onclick = () => {
  modal.classList.remove('hidden');
  refreshServiceStatus();
};
modal.querySelectorAll('[data-close]').forEach((element) => {
  element.onclick = () => modal.classList.add('hidden');
});

$('#copyBtn').onclick = async () => {
  const text = [
    `【视频主题】\n${$('#outTheme').textContent}`,
    `【核心观点】\n${[...$('#outPoints').children].map((item, index) => `${index + 1}. ${item.textContent}`).join('\n')}`,
    `【一句话总结】\n${$('#outSummary').textContent}`,
    `【关键案例】\n${[...$('#outCases').children].map((item) => item.textContent).join('\n')}`,
    `【完整文字稿】\n${transcriptTextForExport()}`,
  ].join('\n\n');
  try {
    await navigator.clipboard.writeText(text);
    $('#copyBtn').textContent = '✓ 已复制';
    setTimeout(() => { $('#copyBtn').textContent = '▣ 复制'; }, 1400);
  } catch {
    $('#copyBtn').textContent = '复制失败';
    setTimeout(() => { $('#copyBtn').textContent = '▣ 复制'; }, 1400);
  }
};

$('#exportBtn').onclick = () => {
  const text = [
    `视频主题：${$('#outTheme').textContent}`,
    `\n核心观点：\n${[...$('#outPoints').children].map((item, index) => `${index + 1}. ${item.textContent}`).join('\n')}`,
    `\n一句话总结：${$('#outSummary').textContent}`,
    `\n关键案例：\n${[...$('#outCases').children].map((item) => item.textContent).join('\n')}`,
    `\n完整文字稿：\n${transcriptTextForExport()}`,
  ].join('\n');
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'DOUBLE-视频分析.txt';
  link.click();
  URL.revokeObjectURL(url);
};

$('#toggleTranscript').onclick = () => {
  const transcript = $('#transcriptList');
  transcript.classList.toggle('expanded');
  $('#toggleTranscript').textContent = transcript.classList.contains('expanded') ? '收起 ↑' : '展开全文 ↓';
};
