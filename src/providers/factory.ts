import { readFileSync, existsSync } from "node:fs";
import { resolve } from "path";
import type { LLMProvider, ProviderConfig } from "./types.js";
import { DeepseekProvider } from "./deepseek.js";
import { ClaudeProvider } from "./claude.js";
import { OpenAIProvider } from "./openai.js";


const LING_JSON = ".ling.json"

/** 从 .ling.json 读取配置 */
function loadConfigFile(): Partial<ProviderConfig> | null {
  const configPath = resolve(process.cwd(), LING_JSON);
  if(!existsSync(configPath)) return null;
  try {
    return JSON.parse(readFileSync(configPath, "utf-8"));
  }catch {
    return null;
  }
}

/**
 * 配置优先级: 命令行参数 > 环境变量 > .ling.json > 默认值
 */
export function resolveConfig(cliArgs?: Partial<ProviderConfig>): ProviderConfig {
  // 1. 加载 .ling.json 配置文件
  const fileConfig = loadConfigFile();

  const provider = cliArgs?.provider
    || (process.env.LING_PROVIDER as ProviderConfig["provider"])
    || fileConfig?.provider
    || "deepseek";

  const apiKey = cliArgs?.apiKey
    || process.env.LING_API_KEY
    || process.env.LLM_API_KEY
    || fileConfig?.apiKey
    || "";

  const defaultModels: Record<string, string> = {
    deepseek: "deepseek-flash",
    claude: "claude-sonnet-4-20250514",
    openai: "gpt-4o",
  }

  const model = cliArgs?.model
    || process.env.LING_MODEL
    || process.env.LLM_MODEL
    || fileConfig?.model
    || defaultModels[provider];

  const baseURL = cliArgs?.baseURL
    || process.env.LING_BASE_URL
    || process.env.LLM_BASE_URL
    || fileConfig?.baseURL;

  return { provider, apiKey, model, baseURL };
}

/** 根据配置创建 Provider 实例 */
export function createProvider(config: ProviderConfig): LLMProvider {
  switch(config.provider){
    case "deepseek":
      return new DeepseekProvider(config.apiKey, config.model, config.baseURL);
    case "claude":
      return new ClaudeProvider(config.apiKey, config.model);
    case "openai":
      return new OpenAIProvider(config.apiKey, config.model, config.baseURL);
    default:
      throw new Error(`Unkonwn provider: ${config.provider}`);
  }
}

/**
 * 校验配置 + 创建 provider 实例。
 *
 * 入参必须是 resolveConfig 的输出 —— 优先级链(命令行 > 环境变量 > .ling.json >
 * 默认值)在那一步就已经走完, 这里不重复解析。调用方拿到同一份 config,
 * 建实例和记环境信息就不会对不上。
 *
 * 缺 key 时抛错而不是 process.exit: 创建路径必须能被宿主(测试 / SDK / CI)
 * 捕获并自行决定怎么收场, 直接杀进程只在 CLI 边界上才是对的。
 */
export function initProvider(config: ProviderConfig): LLMProvider {
  if(!config.apiKey){
    throw new Error(
      `No API key found. Set LING_API_KEY environment variable or add apiKey to .ling.json`,
    )
  }
  // 走 stderr: 非交互模式下 stdout 是给机器读的(JSON/stream), 混一行日志进去就废了
  console.error(`[ling] Using ${config.provider} / ${config.model}`);
  return createProvider(config);
}