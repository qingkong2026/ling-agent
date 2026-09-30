// Token 预算管理
// 1.CJK 字符 (汉字、日文假名、全角标点等)匹配范围

const CJK_RE = /[\u3000-\u9fff\uf900-\ufaff\uff00-\uffef]/g;

export function estimateTokens(text: string): number {
  // 粗略估算：英文/代码约 4 字符/token；CJK 约 1.5 字符/token
  // 中文若直接按 /4 估算会严重低估，导致预算系统性偏大
  const cjkChars = (text.match(CJK_RE) ?? []).length;
  const otherChars = text.length - cjkChars;
  return Math.ceil(cjkChars / 1.5 + otherChars / 4);
}

export interface TokenBudget {
  total: number;        // 模型上下文窗口大小
  systemPrompt: number; // system prompt 占用
  tools: number;        // 工具定义占用
  history: number;      // 历史消息占用
  reserved: number;     // 留给工具返回结果的空间
  available: number;    // 剩余可用
}

export function calculateBudget(
  contextWindow: number,
  systemPrompt: string,
  toolDefs: string,
  history: string,
): TokenBudget {
  const systemPromptTokens = estimateTokens(systemPrompt);
  const toolTokens = estimateTokens(toolDefs);
  const historyTokens = estimateTokens(history);
  // 留 30% 给工具返回结果
  const reserved = Math.floor(contextWindow * 0.3);
  const available = contextWindow - systemPromptTokens - toolTokens - reserved;

  return {
    total: contextWindow,
    systemPrompt: systemPromptTokens,
    tools: toolTokens,
    history: historyTokens,
    reserved,
    available: Math.max(0, available),
  };
}