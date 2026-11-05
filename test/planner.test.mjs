import test from 'node:test';
import assert from 'node:assert/strict';
import {planTask} from '../src/planner.mjs';
test('明确中文/ISO月份可识别，预设模式准确披露',()=>{
  assert.equal(planTask({text:'整理2026年9月采购月报'}).month,'2026-09');
  assert.equal(planTask({text:'整理2026-10入库月报'}).mode,'preset_mock');
  assert.equal(planTask({text:'审批采购单'}).supported,false);
  assert.equal(planTask({text:'你好'}).supported,false);
  assert.equal(planTask({text:'整理财务月报'}).supported,false);
  assert.equal(planTask({text:'整理2026年11月采购月报'}).supported,false);
});
test('冲突、含糊、多月份及非法参数不静默执行',()=>{
  assert.throws(()=>planTask({text:'整理2026-09采购月报',month:'2026-10'}),/MONTH_CONFLICT/);
  assert.throws(()=>planTask({text:'整理2026-09与2026-10采购月报'}),/MONTH_AMBIGUOUS/);
  assert.throws(()=>planTask({text:'采购月报',month:'2026-99'}),/MONTH_INVALID/);
  assert.throws(()=>planTask({text:'整理2026年13月采购月报'}),/MONTH_INVALID/);
  assert.throws(()=>planTask({text:'x'.repeat(2001)}),/TASK_INPUT_INVALID/);
});
