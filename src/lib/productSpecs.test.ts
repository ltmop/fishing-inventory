// 渔具规格映射单测：品类→字段列表、一行格式化、表单状态互转
import { describe, expect, it } from 'vitest'
import { CATEGORIES } from '@/types'
import {
  SPEC_FIELDS, collectSpecs, formatSpecs, specFieldsFor, specsToForm,
} from './productSpecs'

describe('specFieldsFor', () => {
  it('鱼竿出长度/调性/硬度', () => {
    expect(specFieldsFor('鱼竿')).toEqual(['rod_length', 'rod_action', 'power_rating'])
  })

  it('鱼钩出钩号/材质/颜色', () => {
    expect(specFieldsFor('鱼钩')).toEqual(['hook_size', 'material', 'color'])
  })

  it('鱼线出线号/材质/颜色', () => {
    expect(specFieldsFor('鱼线')).toEqual(['line_number', 'material', 'color'])
  })

  it('鱼饵类出保质期/颜色', () => {
    for (const c of ['饵料', '活饵', '小药', '路亚假饵']) {
      expect(specFieldsFor(c)).toEqual(['expiry_date', 'color'])
    }
  })

  it('其他品类只出通用的颜色/材质', () => {
    for (const c of CATEGORIES) {
      if (['鱼竿', '鱼钩', '鱼线', '饵料', '活饵', '小药', '路亚假饵'].includes(c)) continue
      expect(specFieldsFor(c)).toEqual(['color', 'material'])
    }
  })
})

describe('formatSpecs', () => {
  it('非空规格拼成一行', () => {
    expect(
      formatSpecs({ rod_length: '3.6m', rod_action: '28调', material: '碳素' }),
    ).toBe('3.6m · 28调 · 碳素')
  })

  it('空值和空白串被跳过', () => {
    expect(formatSpecs({ rod_length: null, color: '  ', material: 'PE' })).toBe('PE')
  })

  it('全空返回空串', () => {
    expect(formatSpecs({})).toBe('')
    expect(
      formatSpecs(Object.fromEntries(SPEC_FIELDS.map((f) => [f, null]))),
    ).toBe('')
  })
})

describe('collectSpecs / specsToForm', () => {
  it('表单空串归 null，非空去空白', () => {
    const form = Object.fromEntries(SPEC_FIELDS.map((f) => [f, ''])) as Record<
      (typeof SPEC_FIELDS)[number],
      string
    >
    form.rod_length = ' 3.6m '
    const out = collectSpecs(form)
    expect(out.rod_length).toBe('3.6m')
    expect(out.color).toBeNull()
    expect(out.expiry_date).toBeNull()
  })

  it('specsToForm 与 collectSpecs 互逆', () => {
    const p = {
      rod_length: '4.5m', rod_action: null, power_rating: null, line_number: null,
      hook_size: '5号', color: null, material: null, expiry_date: null,
    }
    const form = specsToForm(p)
    expect(form.rod_length).toBe('4.5m')
    expect(form.rod_action).toBe('')
    expect(collectSpecs(form).hook_size).toBe('5号')
  })
})
