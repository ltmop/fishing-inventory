import { motion } from 'motion/react'
import type { Box } from 'lucide-react'

import { Card, CardContent } from '@/components/ui/card'
import { useCountUp } from '@/lib/useCountUp'

export interface CardSpec {
  title: string
  value: number
  format: (v: number) => string
  unit: string
  icon: typeof Box
  cardClass: string
  iconClass: string
  numClass: string
  pulse?: boolean
  /** 点击跳转/动作：预警卡片必须能点进去处理，否则预警形同虚设 */
  action?: () => void
  actionHint?: string
  /** 主打卡片：占两列、数字更大（库存总值） */
  featured?: boolean
}

/** 仪表盘统计卡：数字滚动动画 + 悬浮上浮 + 可点击跳转 */
export function StatCard({ spec, index }: { spec: CardSpec; index: number }) {
  const animated = useCountUp(spec.value)
  const Icon = spec.icon
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay: index * 0.05, ease: 'easeOut' }}
      whileHover={{ y: -3 }}
      className={spec.featured ? 'col-span-2' : ''}
    >
      <Card
        onClick={spec.action}
        onKeyDown={
          spec.action
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  spec.action!()
                }
              }
            : undefined
        }
        role={spec.action ? 'button' : undefined}
        tabIndex={spec.action ? 0 : undefined}
        className={`h-full border-0 shadow-card transition-shadow hover:shadow-card-hover ${spec.cardClass} ${
          spec.pulse ? 'animate-pulse' : ''
        } ${spec.action ? 'cursor-pointer focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none' : ''}`}
      >
        <CardContent className={spec.featured ? 'flex h-full items-center gap-5 pt-6' : 'pt-6'}>
          <div className={`inline-flex rounded-full p-2.5 ${spec.iconClass} ${spec.featured ? 'mb-0 p-3.5' : 'mb-3'}`}>
            <Icon className={spec.featured ? 'size-7' : 'size-5'} />
          </div>
          <div>
            <div className={`text-xs ${spec.featured ? 'text-white/70' : 'text-slate-500'}`}>{spec.title}</div>
            <div
              className={`font-bold leading-tight tabular-nums ${spec.numClass} ${
                spec.featured ? 'text-[36px]' : 'text-[28px]'
              }`}
            >
              {spec.format(animated)}
            </div>
            <div className={`text-xs ${spec.featured ? 'text-white/60' : 'text-slate-400'}`}>
              {spec.unit}
              {spec.actionHint && (
                <span className={spec.featured ? 'ml-1 text-white/80' : 'ml-1 text-brand-500'}>
                  {spec.actionHint} →
                </span>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  )
}
