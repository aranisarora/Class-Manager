/**
 * components/view/render.tsx — spec in, markup out.
 *
 * The one place a component type becomes an element. Adding a component to the
 * registry means adding a file and a case here — which is the point of §15's
 * "adding one is a file" rather than a rewrite of the renderer.
 *
 * A type that reaches here without a case renders as `table`, which is the same
 * answer the resolver already gives; belt and braces, because an unrenderable
 * page is worse than a plain one.
 */

import type { ResolvedComponent } from '@/lib/web/views'
import { CalendarView } from '@/components/view/calendar'
import { ChartView } from '@/components/view/chart'
import { DetailView } from '@/components/view/detail'
import { FormView } from '@/components/view/form'
import { PeopleListView } from '@/components/view/people-list'
import { ProseView } from '@/components/view/prose'
import { StatCardsView } from '@/components/view/stat-cards'
import { TableView } from '@/components/view/table'
import { TimelineView } from '@/components/view/timeline'

export function RenderComponent({
  c,
  tz,
  token,
  viewSpecId,
  index,
}: {
  c: ResolvedComponent
  tz: string
  token: string
  viewSpecId: string
  index: number
}) {
  switch (c.spec.type) {
    case 'prose':
      return <ProseView c={c} />
    case 'form':
      return <FormView c={c} token={token} viewSpecId={viewSpecId} index={index} />
    case 'calendar':
      return <CalendarView c={c} tz={tz} token={token} />
    case 'people-list':
      return <PeopleListView c={c} tz={tz} token={token} />
    case 'detail':
      return <DetailView c={c} tz={tz} />
    case 'stat-cards':
      return <StatCardsView c={c} tz={tz} />
    case 'timeline':
      return <TimelineView c={c} tz={tz} token={token} />
    case 'chart':
      return <ChartView c={c} tz={tz} />
    case 'table':
    default:
      return <TableView c={c} tz={tz} token={token} />
  }
}

export default RenderComponent
