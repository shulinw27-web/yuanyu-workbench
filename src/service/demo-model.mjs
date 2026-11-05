const toolCall = (name, input) => ({ role: 'assistant', content: null, tool_calls: [{
  id: `demo-${name}`, type: 'function', function: { name, arguments: JSON.stringify(input) },
}] });
const role = (element) => ({ input: 'textbox', textarea: 'textbox', select: 'combobox', a: 'link', button: 'button' }[element.tag] || element.role);

/** Deterministic synthetic responses; this function never contacts a model or a business site. */
export function demoModelMessage({ messages, tools }) {
  const names = tools.map((tool) => tool.function.name);
  const userText = messages.filter((message) => message.role === 'user').map((message) => message.content).join('\n');
  const months = [...new Set(userText.match(/20\d\d-(?:0[1-9]|1[0-2])/g) || [])];
  const month = months[0] || '2026-10';
  if (names.includes('propose_workflow_plan')) {
    const supported = /采购|入库|月报|purchase/i.test(userText) && months.length <= 1;
    return toolCall('propose_workflow_plan', { recipeId: supported ? 'purchase-monthly' : null, month,
      explanation: supported ? '合成规则演示：建议固定采购月报配方，未执行任务，也不是LLM理解结果。' : '合成规则演示无法确定适用配方，请说明采购入库月报目标及单一月份。',
      needsClarification: !supported });
  }
  if (names.includes('browser_open')) {
    const system = messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n');
    const siteId = /Allowed sites:\s*([a-z][a-zA-Z0-9_-]*)(?:\.|,|\s)/.exec(system)?.[1];
    if (siteId !== 'interactive-mock' || !['2026-09', '2026-10'].includes(month)) {
      return { role: 'assistant', content: '这是本机合成服务，未读取任何真实页面。浏览器演示仅支持本机合成站点的2026-09或2026-10。' };
    }
    const previous = messages.filter((message) => message.role === 'assistant').flatMap((message) => message.tool_calls || []);
    const last = previous.at(-1)?.function;
    const output = [...messages].reverse().find((message) => message.role === 'tool');
    let page;
    try { page = output ? JSON.parse(output.content) : null; } catch { page = null; }
    if (!last) return toolCall('browser_open', { siteId });
    if (last.name === 'browser_open' || last.name === 'browser_act') return toolCall('browser_observe', { siteId });
    if (!Array.isArray(page?.elements)) return { role: 'assistant', content: '合成服务尚未取得有效页面，不能确认完成。' };
    if (page.elements.some((element) => element.credential)) return toolCall('browser_handoff', { siteId });
    const actions = previous.filter((entry) => entry.function.name === 'browser_act').map((entry) => {
      try { return JSON.parse(entry.function.arguments).action; } catch { return null; }
    }).filter(Boolean);
    if (!actions.some((action) => action.type === 'select')) {
      const element = page.elements.find((entry) => role(entry) === 'combobox');
      if (element) return toolCall('browser_act', { siteId, action: { type: 'select', ref: element.ref, value: month } });
    } else if (!actions.some((action) => action.type === 'click')) {
      const element = page.elements.find((entry) => entry.label === '筛选合成记录');
      if (element) return toolCall('browser_act', { siteId, action: { type: 'click', ref: element.ref } });
    } else {
      const record = month === '2026-09' ? 'SYN-091' : 'SYN-101', cents = month === '2026-09' ? 9087 : 12345;
      if (page.text?.includes(record) && page.text.includes(String(cents))) {
        return { role: 'assistant', content: `合成规则演示：工具返回页面包含 ${month}、${record}、${cents} 分。仅核对本机合成数据，不代表LLM理解能力。` };
      }
    }
    return { role: 'assistant', content: '合成演示未找到预期页面控件或结果，不能确认任务完成。' };
  }
  return { role: 'assistant', content: '这是免费的本机确定性合成演示，不是LLM。未读取任何网页，也未执行业务任务；真实模型需由服务运营者单独配置。' };
}
