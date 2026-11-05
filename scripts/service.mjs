import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPromotionService,createSponsoredProvider } from '../src/service/index.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const within = (file) => { const offset = relative(repository, file); return !offset || (!isAbsolute(offset) && offset !== '..' && !offset.startsWith(`..${sep}`)); };
const configFile = process.env.YUANYU_PROMOTION_CONFIG;
let config = {};
if (configFile) {
  if (!isAbsolute(configFile) || within(await realpath(configFile))) throw new Error('服务配置必须位于仓库外。');
  const bytes = await readFile(configFile);
  if (bytes.length > 16_384) throw new Error('服务配置过大。');
  config = JSON.parse(bytes.toString('utf8'));
  if (!config || Array.isArray(config) || Object.keys(config).some((key) => !['dataDir', 'host', 'port', 'demo', 'monthlyTokens', 'dailyRequests', 'globalMonthlyTokens','developer', 'models','providers'].includes(key))) throw new Error('服务配置字段无效。');
}
const {providers,...settings}=config;
if(providers&&settings.demo!==false)throw new Error('真实推广模型须明确设置 demo:false；启动不会调用模型。');
if(providers&&settings.models)throw new Error('providers 会生成公开模型目录，请移除重复的 models。');
const upstream=providers?createSponsoredProvider({providers}):null;
const service = await createPromotionService({ dataDir: process.env.YUANYU_PROMOTION_DATA_DIR || join(process.env.LOCALAPPDATA || homedir(), 'YuanyuWorkbench', 'promotion-service'), port: 15334,monthlyTokens:100_000,dailyRequests:20,...settings,...(upstream?{models:upstream.models,requestModel:upstream.requestModel}:{}) });
process.stdout.write(`个人注册与推广额度服务：${service.url}\n${settings.demo===false?'真实推广模式：须设置全局预算并验证账户；仅显式推理请求可能调用已配置的付费模型。':'本机合成演示，不调用付费模型。'}企业入口通过公开开发者联系方式联系。\n`);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { service.close().then(() => process.exit(0), () => process.exit(1)); });
