// AI 文稿后处理（BYOK）：任意 OpenAI 兼容接口——OpenAI/DeepSeek/硅基流动/Ollama/LM Studio 通吃
// key 只存本地 settings.json，不经过任何第三方
const TASKS = {
  summary: {
    sys: '你是视频文稿助理。把用户给的视频/音频文字稿总结成结构化内容，用简体中文 Markdown 输出：一级标题为主题，然后「核心要点」列表（每条一句话）、「关键人物/数字」列表（如有）、「一句话总结」。只输出结果，不要解释。',
    user: t => `文字稿：\n${t}`,
  },
  translate: {
    sys: '你是专业字幕翻译。把用户给的内容逐段翻译成简体中文，忠实原意、口语自然。如果有 SRT 时间戳行（00:00:xx --> ...）原样保留不译。只输出译文，不要解释。',
    user: t => t,
  },
  srtTranslate: {
    sys: '你是专业字幕翻译。输入是编号字幕行（每行格式「N|文本」）。把每条逐条翻译成简体中文，忠实原意、口语自然、符合字幕长度习惯。输出必须与输入行数相同、编号相同，每行严格为「N|译文」，禁止输出编号范围之外的任何内容（无解释、无空行、无代码块标记）。',
    user: t => t,
  },
  groupSummary: {
    sys: '你是媒体库资料整理助理。输入是一个 UP 主/图站账号下多篇内容的文字稿（每篇以「## 标题」开头）。输出简体中文 Markdown 结构化总结：一级标题为主题；「内容概览」2-4 句概括这批内容整体讲什么；「各篇要点」列表（每篇一行：**标题** — 一句话要点；无文字稿的略过）；「值得回看」1-3 条推荐及理由。只输出结果，不要解释。',
    user: t => t,
  },
};

let CFG = { url: '', key: '', model: '' };
function configure(c) { CFG = { ...CFG, ...c }; }
function ready() { return !!(CFG.url && CFG.key && CFG.model); }

async function run(taskId, text) {
  const task = TASKS[taskId];
  if (!task) throw new Error('未知任务类型');
  if (!ready()) throw new Error('请先在设置里填 AI 接口地址 / API Key / 模型名');
  const body = JSON.stringify({
    model: CFG.model,
    messages: [
      { role: 'system', content: task.sys },
      { role: 'user', content: task.user(String(text).slice(0, 24000)) },   // 防超长：截 24k 字符
    ],
    temperature: 0.4,
  });
  const res = await fetch(CFG.url.replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + CFG.key },
    body,
  });
  if (!res.ok) throw new Error('AI 接口 ' + res.status + ': ' + (await res.text()).slice(0, 200));
  const j = await res.json();
  const out = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (!out) throw new Error('AI 返回为空');
  return out;
}

// 拉取模型列表：GET {base}/models（OpenAI 兼容格式），失败再试 {base}/v1/models
// 解析 OpenAI 格式 { data:[{id:'gpt-4o'}, ...] } → 返回 id 字符串数组（Ollama/LM Studio 的 {name} 也兼容）
// 空数组表示接口正常但无模型（调用方据此回退手动输入）；任何异常抛带人话的 Error
async function fetchModels(baseUrl, apiKey) {
  if (!baseUrl) throw new Error('拉取失败：未填写接口地址（aiUrl）');
  const base = String(baseUrl).trim().replace(/\/+$/, '');
  const candidates = [base + '/models', base + '/v1/models'];
  let lastErr = null;
  for (let i = 0; i < candidates.length; i++) {
    const url = candidates[i];
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { Authorization: 'Bearer ' + (apiKey || '') },
      });
      if (!res.ok) {
        lastErr = new Error('拉取失败：接口返回 HTTP ' + res.status + '（' + url + '）');
        continue;   // 非 200 试下一个候选
      }
      const j = await res.json().catch(() => null);
      const data = j && Array.isArray(j.data) ? j.data : null;
      if (!data) {
        // 200 但结构不是 OpenAI 的 { data:[...] } —— 试下一个候选；都失败则报人话错误
        lastErr = new Error('拉取失败：该地址未返回模型列表（' + url + ' 可能不是 OpenAI 兼容的 /models 接口）');
        continue;
      }
      const ids = [];
      for (const m of data) {
        if (m && typeof m.id === 'string' && m.id) ids.push(m.id);
        else if (m && typeof m.name === 'string' && m.name) ids.push(m.name);
      }
      return ids;   // 可能为空数组 —— 调用方据此回退手动输入
    } catch (e) {
      if (e && typeof e.message === 'string' && e.message.indexOf('拉取失败') === 0) throw e;  // 已封装的人话错误直接上抛
      lastErr = new Error('拉取失败：请求 ' + url + ' 出错（' + (e ? e.message : '未知') + '）');
      continue;
    }
  }
  throw lastErr || new Error('拉取失败：未知错误');
}

module.exports = { configure, ready, run, TASKS, fetchModels };
