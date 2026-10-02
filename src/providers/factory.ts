import { readFileSync, existsSync } from "node:fs";
import { resolve } from "path";
import type { LLMProvider, ProviderConfig } from "./types.js";
import { DeepseekProvider } from "./deepseek.js";
import { ClaudeProvider } from "./claude.js";
import { OpenAIProvider } from "./openai.js";

const LING_JSON = ".ling/.ling.json"

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

/** 一步到位,解析配置 + 创建 provider */
export function initProvider(cliArgs?: Partial<ProviderConfig>): LLMProvider {
  const config = resolveConfig(cliArgs);
  if(!config.apiKey){
    console.error(
      `Error: No API key found. Set LING_API_KEY enviroment variable or add apiKey to .ling.json`,
    )
    process.exit(1);
  }
  console.log(`[ling] Using ${config.provider} / ${config.model}`);
  return createProvider(config);
}