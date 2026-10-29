// 平台的用户配置目录：凭据、价格缓存、用户自定义预设都在这里，不在任何项目目录里。
import { homedir } from 'node:os';
import { join } from 'node:path';

export const APP_DIR_NAME = 'ai-video-platform';

/** AVP_CONFIG_DIR（测试与自定义用）> $XDG_CONFIG_HOME/ai-video-platform > ~/.config/ai-video-platform */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env['AVP_CONFIG_DIR']) return env['AVP_CONFIG_DIR'];
  const base = env['XDG_CONFIG_HOME'] || join(homedir(), '.config');
  return join(base, APP_DIR_NAME);
}
