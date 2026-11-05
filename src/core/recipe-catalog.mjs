const RECIPE_ID = 'purchase-monthly';

function reject(code, message) { throw Object.assign(new Error(message), { code }); }
function object(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.keys(value).some((key) => !allowed.includes(key))) {
    reject('INVALID_TEMPLATE', '模板包含不支持的字段或结构。');
  }
}
function text(value, max, optional = false) {
  if (typeof value !== 'string' || value.length > max || (!optional && !value.trim())
    || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value)) reject('INVALID_TEMPLATE', '模板文字格式无效。');
  return value.trim();
}

/** A description/demonstration planner may propose only this data schema, never executable steps. */
export function validateWorkflowTemplate(input) {
  object(input, ['name', 'description', 'recipeId', 'parameters', 'version']);
  if (input.recipeId !== RECIPE_ID) reject('UNSUPPORTED_RECIPE', '当前仅支持已审核的采购入库月报配方。');
  if (input.version !== undefined && input.version !== 1) reject('INVALID_TEMPLATE', '模板格式版本不受支持。');
  object(input.parameters, ['month']);
  if (typeof input.parameters.month !== 'string' || !/^(20\d\d)-(0[1-9]|1[0-2])$/.test(input.parameters.month)) {
    reject('INVALID_MONTH', '月份格式应为 YYYY-MM。');
  }
  return { name: text(input.name, 100), description: text(input.description ?? '', 2000, true),
    recipeId: RECIPE_ID, parameters: { month: input.parameters.month }, version: 1 };
}

export function listRecipeCatalog() {
  return [{ id: RECIPE_ID, label: '采购入库月报资料整理', mode: 'preset_mock',
    description: '固定受控配方：读取本人采购和仓储数据，核对后生成业务草稿。尚未实现任意流程归纳。',
    templateVersion: 1, editableFields: ['name', 'description', 'parameters.month'],
    parameters: { month: { type: 'string', format: 'YYYY-MM', default: '2026-10' } },
    systems: ['procurement', 'warehouse'], tools: ['system.read', 'report.build'] }];
}
