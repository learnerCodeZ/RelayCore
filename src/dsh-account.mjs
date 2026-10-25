import { isAbsolute } from 'node:path';

export function dshAccountEnvironment(home) {
  if (typeof home !== 'string' || !isAbsolute(home)) throw new Error('DSH account home must be absolute');
  const allowed = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PROGRAMDATA',
    'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'HOME', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => allowed.has(name.toUpperCase())));
  return { ...env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home, DSH_PERMISSION_MODE: 'read-only' };
}

export function accountModelChoice(configOptions) {
  if (!Array.isArray(configOptions)) throw new Error('DSH account model catalog is unavailable');
  const selector = configOptions?.find((option) => option.id === 'model' && option.category === 'model' && option.type === 'select');
  const groups = Array.isArray(selector?.options) ? selector.options.filter((group) => group?.group === 'deepseek-account') : [];
  if (groups?.length !== 1 || !Array.isArray(groups[0].options) || !groups[0].options.length) throw new Error('DSH account model catalog is unavailable');
  const choices = groups[0].options;
  if (choices.some((choice) => !choice || typeof choice.value !== 'string' || !choice.value || choice.value.length > 4096 ||
    typeof choice.name !== 'string' || !choice.name || choice.name.length > 256) || new Set(choices.map((choice) => choice.value)).size !== choices.length) throw new Error('Invalid DSH account model catalog');
  const choice = choices.find((option) => option.value === selector.currentValue) ?? choices[0];
  return { configId: selector.id, value: choice.value, name: choice.name };
}

export async function selectAccountModel(acp, sessionId, configOptions) {
  const choice = accountModelChoice(configOptions);
  const result = await acp.setConfigOption(sessionId, choice.configId, choice.value);
  const confirmed = accountModelChoice(result?.configOptions);
  const selected = result.configOptions.find((option) => option.id === choice.configId)?.currentValue;
  if (selected !== choice.value || confirmed.value !== choice.value) throw new Error('DSH did not confirm the account model');
  return { provider: 'deepseek-account', model: confirmed.name };
}
