export function planTask({ text, month, workflowId } = {}) {
  if (typeof text !== 'string' || !text.trim() || text.length > 2000) throw new Error('TASK_INPUT_INVALID');
  const matches = [...text.matchAll(/(20\d{2})\s*(?:年|[-/])\s*(\d{1,2})(?:月|\b)/g)];
  const periods = [...new Set(matches.map(m => `${m[1]}-${m[2].padStart(2,'0')}`))];
  if(periods.some(value=>!/^20\d{2}-(0[1-9]|1[0-2])$/.test(value)))throw new Error('MONTH_INVALID');
  if (periods.length > 1) throw new Error('MONTH_AMBIGUOUS');
  if (month && periods.length && month !== periods[0]) throw new Error('MONTH_CONFLICT');
  const selected = month || periods[0] || '2026-10';
  if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(selected)) throw new Error('MONTH_INVALID');
  const monthAvailable=['2026-09','2026-10'].includes(selected);
  const supported = monthAvailable && !/删除|付款|转账|审批|发邮件|发送给|提交订单|工资|密码/.test(text) && /采购|入库/.test(text);
  return {
    supported, mode:'preset_mock', recipeId: supported ? 'purchase-monthly' : null,
    month:selected, workflowId:workflowId || null,
    message:supported ? '本次通过两个 Mock 业务网页整理已审核采购与入库资料，生成 CSV 草稿和来源说明。不会提交、审批或外发。' : !monthAvailable ? '当前仅提供2026年9月和10月的合成数据，请选择已有月份。' : '当前是预设 Mock 原型，仅支持采购与入库月报资料整理；尚未接入通用大模型规划。'
  };
}
