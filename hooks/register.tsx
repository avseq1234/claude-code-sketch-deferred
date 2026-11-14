import type { Register } from 'claude-code'

// sketch: tools the model calls in place of paragraphs. Each draws one card in
// the transcript, from the call's own input:
//   layers     the block picture of an architecture: bands, zones, side concerns
//   diagram    nodes and arrows laid out in ranks (wiring, flows, dependencies)
//   schema     tables or classes: boxes with fields, and their relations
//   swimlane   a process across lanes of roles or systems
//   pipeline   stages left to right, each a column of jobs
//   gitgraph   branches, commits, merges and tags over time
//   sequence   who calls whom, in order
//   tree       a hierarchy
//   timeline   bars over periods (roadmap, gantt)
//   board      columns of cards (kanban)
//   quadrant   a 2x2: points on two axes, or four lists (SWOT)
//   journey    stages with a mood curve and rows of notes
//   wireframe  a low-fidelity screen
//   metrics    number tiles with a trend
//   chart      bar, column, stacked, line, scatter, heatmap, histogram, funnel, share
//   cards      titled cards (personas, findings)
//   compare    options side by side, then a dialog to pick one
// A card keeps no state: the row is drawn again from the input every time.
// The only thing remembered is how far a card's entrance has played, and that
// is the module's own, gone on a reload, where a card simply draws whole.

const toolOf = (name: string): string => `mcp__sketch__${name}`

type UI = { Box: any; Text: any }
type Style = { color?: string; bold?: boolean; dim?: boolean }
type Seg = Style & { text: string }
type Row = { indent: number; segs: Seg[] }

// Eight theme colors that stay apart from each other in the light and dark themes.
const PALETTE = ['claude', 'suggestion', 'success', 'warning', 'bashBorder', 'planMode', 'autoAccept', 'error']
const tint = (index: number): string => PALETTE[index % PALETTE.length] ?? 'claude'
const TONES: Record<string, string> = { good: 'success', bad: 'error', warn: 'warning', plain: 'text' }

// ---------------------------------------------------------------- input

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

const items = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

const words = (value: unknown, max: number): string | undefined => {
  const text = typeof value === 'number' ? String(value) : value
  if (typeof text !== 'string') return undefined
  // The text comes from the model, which may be relaying something it read:
  // control characters and direction overrides never reach the terminal.
  const trimmed = text
    .replace(/\s+/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .trim()
  if (trimmed === '') return undefined

  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
}

const wordList = (value: unknown, count: number, max: number): string[] =>
  items(value)
    .map(one => words(one, max))
    .filter((one): one is string => one !== undefined)
    .slice(0, count)

const num = (value: unknown): number | undefined => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const parsed = Number(value.replace(/[,_%$]/g, ''))

  return Number.isFinite(parsed) ? parsed : undefined
}

const numbers = (value: unknown, count: number): number[] =>
  items(value)
    .map(num)
    .filter((one): one is number => one !== undefined)
    .slice(0, count)

const clamp = (value: number, low: number, high: number): number =>
  Math.max(low, Math.min(high, value))

const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback

// ---------------------------------------------------------------- text cells

const isWide = (code: number): boolean =>
  code >= 0x1100 &&
  (code <= 0x115f ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd))

const cellsOf = (char: string): number => {
  const code = char.codePointAt(0) ?? 0
  if ((code >= 0x300 && code <= 0x36f) || code === 0x200b || code === 0xfe0f) return 0

  return isWide(code) ? 2 : 1
}

const widthOf = (text: string): number => {
  let width = 0
  for (const char of text) width += cellsOf(char)

  return width
}

const clip = (text: string, max: number): string => {
  if (max <= 0) return ''
  if (widthOf(text) <= max) return text
  let out = ''
  let width = 0
  for (const char of text) {
    const cells = cellsOf(char)
    if (width + cells > max - 1) break
    out += char
    width += cells
  }

  return `${out}…`
}

const padEnd = (text: string, width: number): string => {
  const cut = clip(text, width)

  return cut + ' '.repeat(Math.max(0, width - widthOf(cut)))
}

const padStart = (text: string, width: number): string => {
  const cut = clip(text, width)

  return ' '.repeat(Math.max(0, width - widthOf(cut))) + cut
}

const trimNumber = (value: number, digits: number): string => {
  const fixed = value.toFixed(digits)

  return fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed
}

const fmt = (value: number): string => {
  const size = Math.abs(value)
  if (size >= 1e9) return `${trimNumber(value / 1e9, 1)}B`
  if (size >= 1e6) return `${trimNumber(value / 1e6, 1)}M`
  if (size >= 1e4) return `${trimNumber(value / 1e3, 1)}k`

  return trimNumber(value, size >= 100 ? 0 : size >= 10 ? 1 : 2)
}

// ---------------------------------------------------------------- canvas
// A grid of cells for what flex boxes cannot draw: wires that cross and join.
// A wire is a set of directions per cell, so two that meet become a joint.

type Cell = Style & { ch: string; mask: number; isRound?: boolean }
type Canvas = { w: number; h: number; cells: Cell[][] }

const UP = 1
const DOWN = 2
const LEFT = 4
const RIGHT = 8
const JOINTS = [' ', '│', '│', '│', '─', '┘', '┐', '┤', '─', '└', '┌', '├', '─', '┴', '┬', '┼']
const SKIP = '\u0000'
const WIRE: Style = { color: 'inactive' }

const makeCanvas = (w: number, h: number): Canvas => ({
  w,
  h,
  cells: Array.from({ length: Math.max(0, h) }, () =>
    Array.from({ length: Math.max(0, w) }, () => ({ ch: '', mask: 0 })),
  ),
})

const cellAt = (canvas: Canvas, x: number, y: number): Cell | undefined =>
  canvas.cells[y]?.[x]

const put = (canvas: Canvas, x: number, y: number, text: string, style: Style = {}): void => {
  let at = x
  for (const char of text) {
    const cells = cellsOf(char)
    if (cells === 0) continue
    const cell = at >= 0 && at + cells <= canvas.w ? cellAt(canvas, at, y) : undefined
    if (cell) {
      cell.ch = char
      cell.mask = 0
      cell.color = style.color
      cell.bold = style.bold
      cell.dim = style.dim
      const next = cells === 2 ? cellAt(canvas, at + 1, y) : undefined
      if (next) {
        next.ch = SKIP
        next.mask = 0
      }
    }
    at += cells
  }
}

const wire = (canvas: Canvas, x: number, y: number, bits: number, style: Style = WIRE): void => {
  const cell = x >= 0 ? cellAt(canvas, x, y) : undefined
  if (!cell || cell.ch !== '') return
  cell.mask |= bits
  cell.color = style.color
  cell.dim = style.dim
}

const vline = (canvas: Canvas, x: number, y1: number, y2: number, style: Style = WIRE): void => {
  const low = Math.min(y1, y2)
  const high = Math.max(y1, y2)
  for (let y = low; y <= high; y++) {
    wire(canvas, x, y, (y > low ? UP : 0) | (y < high ? DOWN : 0), style)
  }
}

const hline = (canvas: Canvas, y: number, x1: number, x2: number, style: Style = WIRE): void => {
  const low = Math.min(x1, x2)
  const high = Math.max(x1, x2)
  for (let x = low; x <= high; x++) {
    wire(canvas, x, y, (x > low ? LEFT : 0) | (x < high ? RIGHT : 0), style)
  }
}

// Room for a text of `width` cells at x, with an empty cell either side of it
// where the canvas has one.
const isFree = (canvas: Canvas, x: number, y: number, width: number): boolean => {
  if (x < 0 || x + width > canvas.w || y < 0 || y >= canvas.h) return false
  for (let at = x - 1; at <= x + width; at++) {
    const cell = at >= 0 ? cellAt(canvas, at, y) : undefined
    if (cell && (cell.ch !== '' || cell.mask !== 0)) return false
  }

  return true
}

const sameStyle = (a: Style, b: Style): boolean =>
  a.color === b.color && Boolean(a.bold) === Boolean(b.bold) && Boolean(a.dim) === Boolean(b.dim)

// Rows of runs: a row never opens on a space (the indent carries those) and a
// run of spaces rides the run before it, so no text depends on kept padding.
const rowsOf = (canvas: Canvas): Row[] =>
  canvas.cells.map(line => {
    let end = line.length
    while (end > 0 && line[end - 1]?.ch === '' && line[end - 1]?.mask === 0) end--
    const segs: Seg[] = []
    let indent = 0
    for (let x = 0; x < end; x++) {
      const cell = line[x]
      if (!cell || cell.ch === SKIP) continue
      const char =
        cell.ch !== '' ? cell.ch : ((cell.isRound ? ROUNDED[cell.mask] : undefined) ?? JOINTS[cell.mask] ?? ' ')
      const last = segs[segs.length - 1]
      if (char === ' ') {
        if (last) last.text += ' '
        else indent++
        continue
      }
      if (last && sameStyle(last, cell)) last.text += char
      else segs.push({ text: char, color: cell.color, bold: cell.bold, dim: cell.dim })
    }

    return { indent, segs }
  })

const ROUNDED: Record<number, string> = { 5: '╯', 6: '╮', 9: '╰', 10: '╭' }

// Lays one layer of wires over a canvas in one color. Where it meets an
// earlier wire at a right angle the two cross; anywhere else the later wire is
// drawn over the earlier, which reads as passing in front of it.
const stamp = (canvas: Canvas, layer: Canvas, style: Style): void => {
  layer.cells.forEach((line, y) =>
    line.forEach((cell, x) => {
      const under = cellAt(canvas, x, y)
      if (cell.mask === 0 || !under || under.ch !== '') return
      const isCrossing = (under.mask === 3 && cell.mask === 12) || (under.mask === 12 && cell.mask === 3)
      under.mask = isCrossing ? 15 : cell.mask
      under.color = style.color
      under.dim = style.dim
      under.isRound = true
    }),
  )
}

// A line through one row per column, as a wire: a level stretch runs flat and
// a change of row turns a corner, so the line is solid at any terminal font.
const trace = (layer: Canvas, rows: (number | undefined)[], upTo: number): void => {
  for (let x = 0; x < Math.min(upTo, rows.length - 1); x++) {
    const here = rows[x]
    const next = rows[x + 1]
    if (here === undefined || next === undefined) continue
    wire(layer, x, here, RIGHT)
    wire(layer, x + 1, here, LEFT)
    if (next !== here) vline(layer, x + 1, here, next)
  }
}

// The row of every column for `count` values spread evenly over `width` columns.
const rowsAcross = (
  values: number[],
  count: number,
  width: number,
  rowOf: (value: number) => number,
): (number | undefined)[] =>
  Array.from({ length: width }, (_, x) => {
    const at = (x / Math.max(1, width - 1)) * Math.max(1, count - 1)
    const before = values[Math.floor(at)]
    const after = values[Math.ceil(at)]
    if (before === undefined || after === undefined) return undefined

    return rowOf(before + (after - before) * (at - Math.floor(at)))
  })

// ---------------------------------------------------------------- elements

const styleOf = (style: Style): Record<string, unknown> => ({
  ...(style.color !== undefined && { color: style.color }),
  ...(style.bold === true && { bold: true }),
  ...(style.dim === true && { dimColor: true }),
})

const rowOf = (ui: UI, row: Row): any =>
  row.segs.length === 0 ? (
    <ui.Text>{' '}</ui.Text>
  ) : (
    <ui.Box flexDirection="row" paddingLeft={row.indent}>
      {row.segs.map(seg => (
        <ui.Text {...styleOf(seg)} wrap="truncate-end">
          {seg.text}
        </ui.Text>
      ))}
    </ui.Box>
  )

const drawRows = (ui: UI, rows: Row[]): any[] => rows.map(row => rowOf(ui, row))

const legendOf = (ui: UI, names: string[], colors: string[], least = 2): any =>
  names.length >= least && (
    <ui.Box flexDirection="row" flexWrap="wrap" columnGap={2}>
      {names.map((name, index) => (
        <ui.Box flexDirection="row" columnGap={1}>
          <ui.Text color={colors[index] ?? tint(index)}>■</ui.Text>
          <ui.Text dimColor>{name}</ui.Text>
        </ui.Box>
      ))}
    </ui.Box>
  )

const notesOf = (ui: UI, notes: string[]): any[] =>
  notes.map(note => (
    <ui.Box flexDirection="row" columnGap={1}>
      <ui.Text color="warning">!</ui.Text>
      <ui.Text color="warning" wrap="wrap">
        {note}
      </ui.Text>
    </ui.Box>
  ))

const frameOf = (ui: UI, title: string, body: any): any => (
  <ui.Box flexDirection="column" marginTop={1}>
    <ui.Text bold color="claude">
      {`◆ ${title}`}
    </ui.Text>
    {body}
  </ui.Box>
)

// ---------------------------------------------------------------- diagram

const SHAPES = ['box', 'round', 'decision', 'store', 'external', 'person'] as const
type Shape = (typeof SHAPES)[number]
// A line inside a node under its name: a field of a table, a member of a class.
type BodyRow = { mark: string; text: string; aside?: string }
type GraphNode = {
  id: string
  label: string
  note?: string
  group?: string
  shape: Shape
  rows: BodyRow[]
  // Labels of the edges from the node to itself.
  loops: string[]
}
type GraphEdge = { from: number; to: number; label?: string; isReversed: boolean }
type Graph = {
  title: string
  layout: 'flow' | 'matrix' | 'zones'
  nodes: GraphNode[]
  edges: GraphEdge[]
  notes: string[]
  dropped: number
}

// A node's frame by shape: top-left, top, top-right, side, bottom-left, bottom,
// bottom-right, then the mark where a wire leaves the bottom and enters the top.
const FRAMES: Record<Shape, string[]> = {
  box: [...'┌─┐│└─┘┬┴'],
  round: [...'╭─╮│╰─╯┬┴'],
  decision: [...'╱─╲│╲─╱┬┴'],
  store: [...'╔═╗║╚═╝╤╧'],
  external: [...'┌┄┐┆└┄┘┬┴'],
  person: [...'╭─╮│╰─╯┬┴'],
}

const readGraph = (input: unknown): Graph | string => {
  const raw = record(input)
  const nodes: GraphNode[] = []
  const index = new Map<string, number>()
  const add = (id: string, label: string, note?: string, group?: string, shape: Shape = 'box'): void => {
    if (index.has(id) || nodes.length >= 28) return
    index.set(id, nodes.length)
    if (!index.has(label)) index.set(label, nodes.length)
    nodes.push({ id, label, note, group, shape, rows: [], loops: [] })
  }
  for (const one of items(raw.nodes)) {
    const node = typeof one === 'string' ? { label: one } : record(one)
    const label = words(node.label ?? node.name ?? node.id, 40)
    if (label === undefined) continue
    add(words(node.id, 40) ?? label, label, words(node.note, 40), words(node.group, 24), pick(node.shape, SHAPES, 'box'))
  }
  // The first version's shape, layers of nodes, still reads: each layer is a group.
  for (const one of items(raw.layers)) {
    const layer = record(one)
    for (const each of items(layer.nodes)) {
      const node = typeof each === 'string' ? { name: each } : record(each)
      const label = words(node.name ?? node.label, 40)
      if (label !== undefined) add(label, label, words(node.note, 40), words(layer.name, 24))
    }
  }
  if (nodes.length === 0) return 'nodes is empty: give at least one node with an id and a label'

  const edges: GraphEdge[] = []
  const seen = new Set<string>()
  let dropped = 0
  for (const one of [...items(raw.edges), ...items(raw.flows)].slice(0, 70)) {
    const edge = record(one)
    const from = index.get(words(edge.from, 40) ?? '')
    const to = index.get(words(edge.to, 40) ?? '')
    if (from !== undefined && from === to) {
      nodes[from]?.loops.push(words(edge.label, 18) ?? '')
      continue
    }
    if (from === undefined || to === undefined || seen.has(`${from}>${to}`)) {
      dropped++
      continue
    }
    seen.add(`${from}>${to}`)
    edges.push({ from, to, label: words(edge.label, 24), isReversed: false })
  }

  return {
    title: words(raw.title, 80) ?? 'Diagram',
    layout: pick(raw.layout, ['flow', 'matrix', 'zones'] as const, 'flow'),
    nodes,
    edges,
    notes: wordList(raw.notes, 4, 120),
    dropped,
  }
}

type Slot = { rank: number; node?: number; x: number; w: number; order: number; ups: Slot[]; downs: Slot[] }
type Link = { from: Slot; to: Slot; edge: number; isFirst: boolean; isLast: boolean; tx: number; bundle?: Bundle }
// The wires that leave one node downward travel as one: a trunk, a lane, and a
// drop to each target, drawn in the node's color so a line can be followed.
type Bundle = { from: Slot; isReversed: boolean; links: Link[]; sx: number; lane: number; color: string }

const nodeColors = (graph: Graph): { colors: string[]; groups: { name: string; color: string }[] } => {
  const groups: { name: string; color: string }[] = []
  const colors = graph.nodes.map((node, index) => {
    if (node.group === undefined) return graph.nodes.some(one => one.group !== undefined) ? 'inactive' : tint(index)
    let group = groups.find(one => one.name === node.group)
    if (!group) {
      group = { name: node.group, color: tint(groups.length) }
      groups.push(group)
    }

    return group.color
  })

  return { colors, groups }
}

// Ranks top to bottom by longest path, order within a rank by the average
// place of a node's neighbours, an edge that skips ranks threaded through them.
const layoutGraph = (graph: Graph, room: number) => {
  const { nodes, edges } = graph
  // A loop is broken where it runs against the order the nodes were given in:
  // an edge on a cycle that points from a later node to an earlier one is laid
  // out upside down (and drawn with its arrow pointing up).
  const reach: boolean[][] = nodes.map(() => nodes.map(() => false))
  for (const edge of edges) {
    const row = reach[edge.from]
    if (row) row[edge.to] = true
  }
  for (let via = 0; via < nodes.length; via++) {
    for (let from = 0; from < nodes.length; from++) {
      const row = reach[from]
      if (!row?.[via]) continue
      for (let to = 0; to < nodes.length; to++) {
        if (reach[via]?.[to]) row[to] = true
      }
    }
  }
  for (const edge of edges) {
    edge.isReversed = edge.from > edge.to && reach[edge.to]?.[edge.from] === true
  }
  const topOf = (edge: GraphEdge): number => (edge.isReversed ? edge.to : edge.from)
  const bottomOf = (edge: GraphEdge): number => (edge.isReversed ? edge.from : edge.to)

  // Zoned, each group is a band: nodes are ranked inside their own group and
  // the bands are stacked in the order the groups first appear.
  const isZoned = graph.layout === 'zones'
  const zoneOf = (node: number): string => nodes[node]?.group ?? ''
  const rank = nodes.map(() => 0)
  for (let pass = 0; pass < nodes.length; pass++) {
    let isChanged = false
    for (const edge of edges) {
      if (isZoned && zoneOf(edge.from) !== zoneOf(edge.to)) continue
      const above = rank[topOf(edge)] ?? 0
      if ((rank[bottomOf(edge)] ?? 0) < above + 1) {
        rank[bottomOf(edge)] = above + 1
        isChanged = true
      }
    }
    if (!isChanged) break
  }
  const zones: string[] = []
  if (isZoned) {
    nodes.forEach((_, node) => {
      if (!zones.includes(zoneOf(node))) zones.push(zoneOf(node))
    })
    let offset = 0
    for (const zone of zones) {
      const members = nodes.map((_, node) => node).filter(node => zoneOf(node) === zone)
      const depth = Math.max(...members.map(node => rank[node] ?? 0)) + 1
      for (const node of members) rank[node] = (rank[node] ?? 0) + offset
      offset += depth
    }
    // Between bands an edge simply runs the way the bands are stacked.
    for (const edge of edges) edge.isReversed = (rank[edge.from] ?? 0) > (rank[edge.to] ?? 0)
  }

  const ranks: Slot[][] = []
  const place = (slot: Slot): Slot => {
    const line = ranks[slot.rank] ?? []
    ranks[slot.rank] = line
    slot.order = line.length
    line.push(slot)

    return slot
  }
  const slotOf = nodes.map((_, node) =>
    place({ rank: rank[node] ?? 0, node, x: 0, w: 0, order: 0, ups: [], downs: [] }),
  )
  for (let at = 0; at < ranks.length; at++) ranks[at] = ranks[at] ?? []

  const links: Link[] = []
  edges.forEach((edge, index) => {
    const first = slotOf[topOf(edge)]
    const last = slotOf[bottomOf(edge)]
    if (!first || !last) return
    let from = first
    for (let at = first.rank + 1; at <= last.rank; at++) {
      const to = at === last.rank ? last : place({ rank: at, x: 0, w: 0, order: 0, ups: [], downs: [] })
      links.push({ from, to, edge: index, isFirst: from === first, isLast: to === last, tx: 0 })
      from.downs.push(to)
      to.ups.push(from)
      from = to
    }
  })

  const reorder = (line: Slot[], near: (slot: Slot) => Slot[]): Slot[] => {
    const keyed = line.map((slot, index) => {
      const around = near(slot)

      return {
        slot,
        key: around.length > 0 ? around.reduce((sum, one) => sum + one.order, 0) / around.length : index,
      }
    })
    keyed.sort((a, b) => a.key - b.key)
    keyed.forEach((one, index) => {
      one.slot.order = index
    })

    return keyed.map(one => one.slot)
  }
  for (let sweep = 0; sweep < 4; sweep++) {
    for (let at = 1; at < ranks.length; at++) ranks[at] = reorder(ranks[at] ?? [], slot => slot.ups)
    for (let at = ranks.length - 2; at >= 0; at--) ranks[at] = reorder(ranks[at] ?? [], slot => slot.downs)
  }

  const widest = Math.max(
    ...nodes.map(node =>
      Math.max(
        widthOf(node.label) + (node.shape === 'person' ? 2 : 0),
        node.note ? Math.min(widthOf(node.note), 20) : 0,
        node.loops.length > 0 ? widthOf(node.loops.join(', ')) + 2 : 0,
        ...node.rows.map(row => 2 + widthOf(row.text) + (row.aside ? widthOf(row.aside) + 2 : 0)),
      ),
    ),
  )
  let nodeW = clamp(widest + 4, 10, nodes.some(node => node.rows.length > 0) ? 38 : 26)
  let gap = 4
  const lineWidth = (line: Slot[]): number =>
    line.reduce((sum, slot) => sum + (slot.node === undefined ? 1 : nodeW), 0) + gap * Math.max(0, line.length - 1)
  const span = (): number => Math.max(1, ...ranks.map(lineWidth))
  while (span() > room && (nodeW > 8 || gap > 1)) {
    if (nodeW > 8) nodeW--
    else gap--
  }
  const packed = span()
  for (const line of ranks) {
    let x = (packed - lineWidth(line)) >> 1
    for (const slot of line) {
      slot.w = slot.node === undefined ? 1 : nodeW
      slot.x = x
      x += slot.w + gap
    }
  }

  // Straighten: each slot is pulled under (or over) the middle of what it is
  // wired to, keeping its place in the row; kept only while the picture fits.
  const middle = (slot: Slot): number => slot.x + (slot.w - 1) / 2
  const all = ranks.flat()
  const before = all.map(slot => slot.x)
  const pull = (line: Slot[], near: (slot: Slot) => Slot[]): void => {
    const want = line.map(slot => {
      const around = near(slot)

      return around.length > 0
        ? around.reduce((sum, one) => sum + middle(one), 0) / around.length - (slot.w - 1) / 2
        : slot.x
    })
    const fromLeft: number[] = []
    line.forEach((slot, index) => {
      const prior = line[index - 1]
      fromLeft[index] = Math.max(want[index] ?? 0, prior ? (fromLeft[index - 1] ?? 0) + prior.w + gap : -Infinity)
    })
    const fromRight: number[] = []
    for (let index = line.length - 1; index >= 0; index--) {
      const slot = line[index]
      const after = line[index + 1]
      if (!slot) continue
      fromRight[index] = Math.min(want[index] ?? 0, after ? (fromRight[index + 1] ?? 0) - slot.w - gap : Infinity)
    }
    line.forEach((slot, index) => {
      slot.x = Math.round(((fromLeft[index] ?? 0) + (fromRight[index] ?? 0)) / 2)
    })
  }
  for (let sweep = 0; sweep < 2; sweep++) {
    for (let at = 1; at < ranks.length; at++) pull(ranks[at] ?? [], slot => slot.ups)
    for (let at = ranks.length - 2; at >= 0; at--) pull(ranks[at] ?? [], slot => slot.downs)
  }
  const least = Math.min(...all.map(slot => slot.x))
  all.forEach(slot => {
    slot.x -= least
  })
  let width = Math.max(...all.map(slot => slot.x + slot.w))
  if (width > room) {
    all.forEach((slot, index) => {
      slot.x = before[index] ?? 0
    })
    width = packed
  }
  if (isZoned) {
    all.forEach(slot => {
      slot.x += 2
    })
    width += 4
  }

  const { colors, groups } = nodeColors(graph)
  const portOf = (slot: Slot, count: number, index: number): number =>
    slot.node === undefined
      ? slot.x
      : slot.x + 1 + Math.min(slot.w - 3, Math.floor(((index + 0.5) * (slot.w - 2)) / count))
  const bundles: Bundle[] = []
  for (const link of links) {
    const edge = edges[link.edge]
    if (!edge) continue
    let bundle = bundles.find(one => one.from === link.from && one.isReversed === edge.isReversed)
    if (!bundle) {
      bundle = { from: link.from, isReversed: edge.isReversed, links: [], sx: 0, lane: 0, color: colors[edge.from] ?? 'inactive' }
      bundles.push(bundle)
    }
    bundle.links.push(link)
    link.bundle = bundle
  }
  for (const slot of all) {
    const leaving = bundles.filter(bundle => bundle.from === slot)
    leaving.forEach((bundle, index) => {
      bundle.sx = portOf(slot, leaving.length, index)
    })
    const arriving = links.filter(link => link.to === slot).sort((a, b) => middle(a.from) - middle(b.from))
    arriving.forEach((link, index) => {
      link.tx = portOf(slot, arriving.length, index)
    })
  }

  // A lane is the row a bundle runs along; two bundles share one only where
  // their spans do not overlap.
  const lanes: number[] = []
  const reachOf = (bundle: Bundle): [number, number] => {
    const xs = [bundle.sx, ...bundle.links.map(link => link.tx)]

    return [Math.min(...xs), Math.max(...xs)]
  }
  for (let at = 0; at < ranks.length - 1; at++) {
    const bent = bundles
      .filter(bundle => bundle.from.rank === at && reachOf(bundle)[0] !== reachOf(bundle)[1])
      .sort((a, b) => reachOf(a)[0] - reachOf(b)[0])
    const ends: number[] = []
    for (const bundle of bent) {
      const [left, right] = reachOf(bundle)
      let lane = ends.findIndex(end => end < left - 1)
      if (lane === -1) lane = ends.length < 8 ? ends.length : ends.indexOf(Math.min(...ends))
      ends[lane] = Math.max(ends[lane] ?? -1, right)
      bundle.lane = lane
    }
    lanes[at] = ends.length
  }

  // A node is as tall as what it holds; plain nodes of one rank share a height.
  const ownTall = (node: GraphNode | undefined): number =>
    3 +
    (node?.note !== undefined ? 1 : 0) +
    (node && node.loops.length > 0 ? 1 : 0) +
    (node && node.rows.length > 0 ? node.rows.length + 1 : 0)
  const plain = ranks.map(line =>
    Math.max(
      3,
      ...line
        .filter(slot => slot.node !== undefined && nodes[slot.node]?.rows.length === 0)
        .map(slot => ownTall(nodes[slot.node ?? -1])),
    ),
  )
  const tallOf = (slot: Slot): number => {
    const node = nodes[slot.node ?? -1]

    return node && node.rows.length > 0 ? ownTall(node) : (plain[slot.rank] ?? 3)
  }
  const heights = ranks.map((line, at) =>
    Math.max(plain[at] ?? 3, ...line.filter(slot => slot.node !== undefined).map(tallOf)),
  )
  const tops: number[] = []
  let height = isZoned ? 1 : 0
  ranks.forEach((_, at) => {
    tops[at] = height
    height += (heights[at] ?? 3) + (at < ranks.length - 1 ? (lanes[at] ?? 0) + 2 : 0)
  })
  if (isZoned) height += 1
  const canvas = makeCanvas(Math.max(width, Math.min(room, width + 20)), height)

  for (const slot of all) {
    const top = tops[slot.rank] ?? 0
    const tall = tallOf(slot)
    if (slot.node === undefined) continue
    const node = nodes[slot.node]
    const frame = FRAMES[node?.shape ?? 'box']
    const border: Style = { color: colors[slot.node] }
    const inner = slot.w - 2
    put(canvas, slot.x, top, `${frame[0]}${(frame[1] ?? '─').repeat(inner)}${frame[2]}`, border)
    for (let y = top + 1; y < top + tall - 1; y++) {
      put(canvas, slot.x, y, frame[3] ?? '│', border)
      put(canvas, slot.x + 1, y, ' '.repeat(inner))
      put(canvas, slot.x + slot.w - 1, y, frame[3] ?? '│', border)
    }
    put(canvas, slot.x, top + tall - 1, `${frame[4]}${(frame[5] ?? '─').repeat(inner)}${frame[6]}`, border)
    const centred = (text: string, y: number, style: Style): void => {
      const cut = clip(text, inner)
      put(canvas, slot.x + 1 + ((inner - widthOf(cut)) >> 1), y, cut, style)
    }
    let line = top + 1
    centred(node?.shape === 'person' ? `☺ ${node.label}` : (node?.label ?? ''), line++, { bold: true })
    if (node?.note !== undefined) centred(node.note, line++, { dim: true })
    if (node && node.loops.length > 0) centred(`↺ ${node.loops.filter(loop => loop !== '').join(', ')}`.trim(), line++, border)
    if (node && node.rows.length > 0) {
      put(canvas, slot.x, line++, `├${'─'.repeat(inner)}┤`, border)
      for (const row of node.rows) {
        put(canvas, slot.x + 1, line, row.mark, { color: 'warning' })
        put(canvas, slot.x + 3, line, clip(row.text, inner - 3))
        if (row.aside !== undefined && widthOf(row.text) + widthOf(row.aside) + 5 <= inner) {
          put(canvas, slot.x + slot.w - 2 - widthOf(row.aside), line, row.aside, { dim: true })
        }
        line++
      }
    }
  }

  const rowsFor = (at: number): { exit: number; arrow: number } => ({
    exit: (tops[at] ?? 0) + (heights[at] ?? 3),
    arrow: (tops[at + 1] ?? 0) - 1,
  })
  // Longer spans first, so a short hop is drawn over a long haul it meets.
  const drawOrder = [...bundles].sort((a, b) => reachOf(b)[1] - reachOf(b)[0] - (reachOf(a)[1] - reachOf(a)[0]))
  // A wire leaves from under its own node, which may end above the rank's last row.
  const startOf = (bundle: Bundle): number =>
    bundle.from.node === undefined ? rowsFor(bundle.from.rank).exit : (tops[bundle.from.rank] ?? 0) + tallOf(bundle.from)
  for (const bundle of drawOrder) {
    const { exit, arrow } = rowsFor(bundle.from.rank)
    const lane = exit + 1 + bundle.lane
    const start = startOf(bundle)
    const layer = makeCanvas(canvas.w, canvas.h)
    const [left, right] = reachOf(bundle)
    // A wire through a rank it skips runs down the slot kept for it.
    for (const link of bundle.links) {
      if (link.to.node === undefined) {
        const top = tops[link.to.rank] ?? 0
        vline(layer, link.to.x, top - 1, top + (heights[link.to.rank] ?? 3))
      }
    }
    if (left === right) vline(layer, bundle.sx, start, arrow)
    else {
      vline(layer, bundle.sx, start, lane)
      hline(layer, lane, left, right)
      for (const link of bundle.links) vline(layer, link.tx, lane, arrow)
    }
    wire(layer, bundle.sx, start, UP)
    for (const link of bundle.links) wire(layer, link.tx, arrow, DOWN)
    stamp(canvas, layer, { color: bundle.color })
  }
  for (const bundle of bundles) {
    const { arrow } = rowsFor(bundle.from.rank)
    const start = startOf(bundle)
    if (bundle.from.node !== undefined) {
      const frame = FRAMES[nodes[bundle.from.node]?.shape ?? 'box']
      put(canvas, bundle.sx, start - 1, frame[7] ?? '┬', { color: colors[bundle.from.node] })
      if (bundle.isReversed) put(canvas, bundle.sx, start, '▲', { color: bundle.color, bold: true })
    }
    for (const link of bundle.links) {
      if (link.to.node === undefined) continue
      if (!bundle.isReversed && link.isLast) put(canvas, link.tx, arrow, '▼', { color: bundle.color, bold: true })
      else {
        const frame = FRAMES[nodes[link.to.node]?.shape ?? 'box']
        put(canvas, link.tx, arrow + 1, frame[8] ?? '┴', { color: colors[link.to.node] })
      }
    }
  }

  // A zone's frame goes round its nodes. Its name is written first, so the
  // edge labels placed next keep clear of it.
  const frames: { color: string; x0: number; x1: number; y0: number; y1: number }[] = []
  if (isZoned) {
    for (const zone of zones) {
      const members = all.filter(slot => slot.node !== undefined && zoneOf(slot.node) === zone)
      if (zone === '' || members.length === 0) continue
      const color = colors[members[0]?.node ?? 0] ?? 'inactive'
      const first = Math.min(...members.map(slot => slot.rank))
      const last = Math.max(...members.map(slot => slot.rank))
      const frame = {
        color,
        x0: Math.min(...members.map(slot => slot.x)) - 2,
        x1: Math.max(...members.map(slot => slot.x + slot.w)) + 1,
        y0: (tops[first] ?? 0) - 1,
        y1: (tops[last] ?? 0) + (heights[last] ?? 3),
      }
      frames.push(frame)
      put(canvas, frame.x0 + 2, frame.y0, clip(` ${zone} `, frame.x1 - frame.x0 - 3), { color, bold: true })
    }
  }

  const loose: string[] = []
  for (const link of links) {
    const edge = edges[link.edge]
    const bundle = link.bundle
    if (!bundle || edge?.label === undefined || !(edge.isReversed ? link.isFirst : link.isLast)) continue
    const text = clip(edge.label, 18)
    const size = widthOf(text)
    const { exit, arrow } = rowsFor(link.from.rank)
    const spots: [number, number][] = [
      [link.tx + 2, arrow],
      [link.tx - size - 1, arrow],
      [bundle.sx + 2, exit],
      [bundle.sx - size - 1, exit],
    ]
    const spot = spots.find(([x, y]) => isFree(canvas, x, y, size))
    if (spot) put(canvas, spot[0], spot[1], text, { color: bundle.color, dim: true })
    else loose.push(`${nodes[edge.from]?.label ?? ''} → ${nodes[edge.to]?.label ?? ''}: ${edge.label}`)
  }

  // The frames go on last and only into empty cells, so wires and labels read
  // as lying over them.
  for (const frame of frames) {
    const { color, x0, x1, y0, y1 } = frame
    const edge = (x: number, y: number, char: string): void => {
      const cell = cellAt(canvas, x, y)
      if (cell && cell.ch === '' && cell.mask === 0) put(canvas, x, y, char, { color, dim: true })
    }
    for (let x = x0 + 1; x < x1; x++) {
      edge(x, y0, '┄')
      edge(x, y1, '┄')
    }
    for (let y = y0 + 1; y < y1; y++) {
      edge(x0, y, '┆')
      edge(x1, y, '┆')
    }
    edge(x0, y0, '┌')
    edge(x1, y0, '┐')
    edge(x0, y1, '└')
    edge(x1, y1, '┘')
  }

  return { rows: rowsOf(canvas), groups: isZoned ? [] : groups, loose, isTooWide: width > room }
}

// Who depends on whom as a grid: clearer than wires once almost everything
// touches everything.
const drawMatrix = (ui: UI, graph: Graph, room: number): any => {
  const { nodes, edges } = graph
  const { colors } = nodeColors(graph)
  const count = nodes.length
  const widest = Math.max(...nodes.map(node => widthOf(node.label)))
  const labelW = clamp(widest, 4, 22)
  // Columns carry their names while the grid fits; past that, numbers that the
  // rows repeat beside their names.
  const named = clamp(widest, 3, 10)
  const isNamed = labelW + 2 + count * (named + 2) + 5 <= room
  const cell = isNamed ? named + 2 : 3
  const nameAt = isNamed ? 0 : 3
  const left = nameAt + labelW + 2
  const markAt = (index: number): number => left + index * cell + (isNamed ? 0 : 1)
  const canvas = makeCanvas(left + count * cell + 5, count + 2)
  nodes.forEach((node, index) => {
    const look: Style = { color: colors[index], bold: true }
    put(canvas, left + index * cell, 0, isNamed ? clip(node.label, named) : padStart(String(index + 1), 2), look)
    if (!isNamed) put(canvas, 0, index + 1, padStart(String(index + 1), 2), look)
    put(canvas, nameAt, index + 1, clip(node.label, labelW), look)
    nodes.forEach((_, other) => {
      const isWired = edges.some(edge => edge.from === index && edge.to === other)
      put(canvas, markAt(other), index + 1, isWired ? '●' : other === index ? '╲' : '·', isWired ? look : { dim: true })
    })
    put(canvas, left + count * cell, index + 1, `→ ${edges.filter(edge => edge.from === index).length}`, { dim: true })
    put(canvas, markAt(index), count + 1, String(edges.filter(edge => edge.to === index).length), { dim: true })
  })
  put(canvas, nameAt, count + 1, '←', { dim: true })
  const sample = edges[0]

  return [
    ...drawRows(ui, rowsOf(canvas)),
    <ui.Text dimColor wrap="truncate-end">
      {`● ${sample ? `${nodes[sample.from]?.label ?? ''} → ${nodes[sample.to]?.label ?? ''}` : 'row → column'}    → uses    ← used by`}
    </ui.Text>,
  ]
}

const drawDiagram = (ui: UI, graph: Graph, room: number): any => {
  if (graph.layout === 'matrix') return [...drawMatrix(ui, graph, room), ...notesOf(ui, graph.notes)]
  const laid = layoutGraph(graph, room)

  return [
    ...drawRows(ui, laid.rows),
    legendOf(ui, laid.groups.map(group => group.name), laid.groups.map(group => group.color), 1),
    ...laid.loose.slice(0, 8).map(line => (
      <ui.Text dimColor wrap="truncate-end">
        {line}
      </ui.Text>
    )),
    ...notesOf(ui, graph.notes),
  ]
}

// ---------------------------------------------------------------- layers
// The block picture of an architecture: bands top to bottom, each holding
// components (plain, or gathered into named zones), with the concerns that cut
// across every band standing beside them.

type Zone = { name: string; items: string[]; zones: Zone[] }
type Band = { name: string; items: string[]; zones: Zone[] }
type Layers = { title: string; bands: Band[]; sides: Zone[]; notes: string[] }

const namesOf = (value: unknown, count: number): string[] =>
  items(value)
    .map(one => words(typeof one === 'object' ? (record(one).name ?? record(one).label) : one, 28))
    .filter((one): one is string => one !== undefined)
    .slice(0, count)

const readLayers = (input: unknown): Layers | string => {
  const raw = record(input)
  const zoneOf = (value: unknown, depth = 0): Zone | undefined => {
    const zone = typeof value === 'string' ? { name: value } : record(value)
    const name = words(zone.name, 24)
    if (name === undefined) return undefined

    return {
      name,
      items: namesOf(zone.items, 10),
      zones:
        depth >= 3
          ? []
          : items(zone.zones)
              .map(one => zoneOf(one, depth + 1))
              .filter((one): one is Zone => one !== undefined)
              .slice(0, 5),
    }
  }
  const bands: Band[] = []
  for (const one of items(raw.layers).slice(0, 8)) {
    const band = record(one)
    const name = words(band.name, 20)
    if (name === undefined) continue
    bands.push({
      name,
      items: namesOf(band.items, 12),
      zones: items(band.zones ?? band.groups)
        .map(one => zoneOf(one))
        .filter((zone): zone is Zone => zone !== undefined)
        .slice(0, 5),
    })
  }
  if (bands.length === 0) return 'layers is empty: each needs a name and items (names) or zones [{ name, items }]'

  return {
    title: words(raw.title, 80) ?? 'Architecture',
    bands,
    sides: items(raw.sides)
      .map(one => zoneOf(one))
      .filter((zone): zone is Zone => zone !== undefined)
      .slice(0, 3),
    notes: wordList(raw.notes, 4, 120),
  }
}

const drawLayers = (ui: UI, layers: Layers, room: number): any => {
  const sideW = layers.sides.length === 0 ? 0 : clamp(Math.max(...layers.sides.flatMap(side => [side.name, ...side.items]).map(widthOf)) + 4, 10, 20)
  const mainW = Math.max(30, room - layers.sides.length * (sideW + 1))
  const labelW = clamp(Math.max(...layers.bands.map(band => widthOf(band.name))), 4, 14) + 1
  const chips = (names: string[], color: string): any => (
    <ui.Box flexDirection="row" flexWrap="wrap" columnGap={1} rowGap={1}>
      {names.map(name => (
        <ui.Text inverse color={color} wrap="truncate-end">
          {` ${name} `}
        </ui.Text>
      ))}
    </ui.Box>
  )

  const zoneBox = (zone: Zone, color: string): any => (
    <ui.Box borderStyle="single" borderColor={color} borderDimColor flexDirection="column" paddingX={1}>
      <ui.Text dimColor bold wrap="truncate-end">
        {zone.name}
      </ui.Text>
      {zone.items.length > 0 && chips(zone.items, color)}
      {zone.zones.length > 0 && (
        <ui.Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          {zone.zones.map(inner => zoneBox(inner, color))}
        </ui.Box>
      )}
    </ui.Box>
  )

  return [
    <ui.Box flexDirection="row" columnGap={1}>
      <ui.Box flexDirection="column" width={mainW}>
        {layers.bands.map((band, index) => {
          const color = tint(index)

          return (
            <ui.Box borderStyle="round" borderColor={color} flexDirection="row" paddingX={1} width={mainW}>
              <ui.Box width={labelW} flexShrink={0}>
                <ui.Text bold color={color} wrap="truncate-end">
                  {band.name}
                </ui.Text>
              </ui.Box>
              <ui.Box flexDirection="column" flexShrink={1} rowGap={band.items.length > 0 && band.zones.length > 0 ? 1 : 0}>
                {band.items.length > 0 && chips(band.items, color)}
                {band.zones.length > 0 && (
                  <ui.Box flexDirection="row" flexWrap="wrap" columnGap={1}>
                    {band.zones.map(zone => zoneBox(zone, color))}
                  </ui.Box>
                )}
              </ui.Box>
            </ui.Box>
          )
        })}
      </ui.Box>
      {layers.sides.map(side => (
        <ui.Box borderStyle="round" borderColor="inactive" flexDirection="column" paddingX={1} width={sideW}>
          <ui.Text bold wrap="truncate-end">
            {side.name}
          </ui.Text>
          {side.items.map(item => (
            <ui.Text dimColor wrap="truncate-end">
              {item}
            </ui.Text>
          ))}
        </ui.Box>
      ))}
    </ui.Box>,
    ...notesOf(ui, layers.notes),
  ]
}

// ---------------------------------------------------------------- schema
// Tables or classes: each a box with its fields under its name, laid out and
// wired like any diagram.

const readSchema = (input: unknown): Graph | string => {
  const raw = record(input)
  const nodes: GraphNode[] = []
  const index = new Map<string, number>()
  for (const one of items(raw.entities).slice(0, 14)) {
    const entity = record(one)
    const name = words(entity.name, 30)
    if (name === undefined || index.has(name)) continue
    index.set(name, nodes.length)
    const rows: BodyRow[] = []
    for (const each of items(entity.fields ?? entity.members).slice(0, 14)) {
      const field = typeof each === 'string' ? { name: each } : record(each)
      const text = words(field.name, 30)
      if (text === undefined) continue
      rows.push({ mark: field.key === 'pk' ? '◆' : field.key === 'fk' ? '◇' : ' ', text, aside: words(field.type, 16) })
    }
    nodes.push({ id: name, label: name, note: words(entity.note, 30), group: words(entity.group, 24), shape: 'box', rows, loops: [] })
  }
  if (nodes.length === 0) return 'entities is empty: each needs a name and fields [{ name, type, key }]'

  const edges: GraphEdge[] = []
  const seen = new Set<string>()
  let dropped = 0
  for (const one of items(raw.relations).slice(0, 40)) {
    const relation = record(one)
    const from = index.get(words(relation.from, 30) ?? '')
    const to = index.get(words(relation.to, 30) ?? '')
    const label = [words(relation.kind, 18), words(relation.label, 16)].filter(Boolean).join(' ') || undefined
    if (from !== undefined && from === to) {
      nodes[from]?.loops.push(label ?? '')
      continue
    }
    if (from === undefined || to === undefined || seen.has(`${from}>${to}`)) {
      dropped++
      continue
    }
    seen.add(`${from}>${to}`)
    edges.push({ from, to, label, isReversed: false })
  }

  return { title: words(raw.title, 80) ?? 'Schema', layout: 'flow', nodes, edges, notes: wordList(raw.notes, 4, 120), dropped }
}

// ---------------------------------------------------------------- swimlane
// A process read left to right, each step sitting in the lane of whoever does it.

type Stride = { label: string; lane: number; next: number[] }
type Swimlane = { title: string; lanes: string[]; steps: Stride[] }

const readSwimlane = (input: unknown): Swimlane | string => {
  const raw = record(input)
  const lanes = wordList(raw.lanes, 6, 16)
  const ids: string[] = []
  const drafts: { label: string; lane: number; next?: string[] }[] = []
  for (const one of items(raw.steps).slice(0, 10)) {
    const step = record(one)
    const label = words(step.label, 30)
    const laneName = words(step.lane, 16)
    if (label === undefined || laneName === undefined) continue
    let lane = lanes.indexOf(laneName)
    if (lane === -1) {
      if (lanes.length >= 6) continue
      lane = lanes.push(laneName) - 1
    }
    ids.push(words(step.id, 30) ?? label)
    drafts.push({ label, lane, next: Array.isArray(step.next) ? wordList(step.next, 4, 30) : undefined })
  }
  if (drafts.length < 2) return 'steps needs at least two, each a label and a lane (one of lanes), in the order they happen'

  return {
    title: words(raw.title, 80) ?? 'Process',
    lanes,
    // A step hands over to the one after it unless it names where it goes.
    steps: drafts.map((draft, at) => ({
      label: draft.label,
      lane: draft.lane,
      next: draft.next
        ? draft.next.map(id => ids.indexOf(id)).filter(to => to > at)
        : at < drafts.length - 1
          ? [at + 1]
          : [],
    })),
  }
}

// A label over at most two lines of `width` cells, broken at a space when one fits.
const twoLines = (text: string, width: number): [string, string] => {
  if (widthOf(text) <= width) return [text, '']
  let cut = 0
  let used = 0
  let space = -1
  const chars = [...text]
  while (cut < chars.length && used + cellsOf(chars[cut] ?? '') <= width) {
    if (chars[cut] === ' ') space = cut
    used += cellsOf(chars[cut] ?? '')
    cut++
  }
  const at = space > 0 ? space : cut

  return [chars.slice(0, at).join(''), clip(chars.slice(at).join('').trim(), width)]
}

const drawSwimlane = (ui: UI, swim: Swimlane, room: number): any => {
  const nameW = clamp(Math.max(...swim.lanes.map(widthOf)), 4, 12) + 2
  const cell = clamp(Math.floor((room - nameW) / swim.steps.length), 13, 24)
  const box = cell - 4
  const tall = 6
  const canvas = makeCanvas(nameW + swim.steps.length * cell, swim.lanes.length * tall + 1)
  const leftOf = (at: number): number => nameW + at * cell
  const rowOfLane = (lane: number): number => lane * tall + 2
  swim.lanes.forEach((lane, at) => {
    put(canvas, 0, at * tall, '┄'.repeat(canvas.w), { dim: true })
    put(canvas, 0, rowOfLane(at), clip(lane, nameW - 1), { color: tint(at), bold: true })
  })
  put(canvas, 0, swim.lanes.length * tall, '┄'.repeat(canvas.w), { dim: true })
  swim.steps.forEach((step, at) => {
    const x = leftOf(at)
    const y = rowOfLane(step.lane)
    const border: Style = { color: tint(step.lane) }
    put(canvas, x, y - 1, `╭${'─'.repeat(box - 2)}╮`, border)
    put(canvas, x, y, `│${' '.repeat(box - 2)}│`, border)
    put(canvas, x, y + 1, `│${' '.repeat(box - 2)}│`, border)
    put(canvas, x, y + 2, `╰${'─'.repeat(box - 2)}╯`, border)
    twoLines(step.label, box - 2).forEach((line, index) => {
      put(canvas, x + 1 + ((box - 2 - widthOf(line)) >> 1), y + index, line, { bold: true })
    })
  })
  swim.steps.forEach((step, at) => {
    for (const to of step.next) {
      const target = swim.steps[to]
      if (!target) continue
      const layer = makeCanvas(canvas.w, canvas.h)
      const from = rowOfLane(step.lane)
      const into = rowOfLane(target.lane)
      const start = leftOf(at) + box
      const end = leftOf(to) - 2
      if (from === into) hline(layer, from, start, end)
      else {
        hline(layer, from, start, start + 1)
        vline(layer, start + 1, from, into)
        hline(layer, into, start + 1, end)
      }
      stamp(canvas, layer, { color: tint(step.lane) })
      put(canvas, end + 1, into, '▶', { color: tint(step.lane), bold: true })
    }
  })

  return drawRows(ui, rowsOf(canvas))
}

// ---------------------------------------------------------------- pipeline
// Stages left to right, each a column of jobs: CI/CD, ETL, any flow that
// reads as "then".

type Job = { label: string; status?: Status }
type Pipeline = { title: string; stages: { name: string; jobs: Job[] }[]; labels: Record<Status, string> }

const JOB_MARK: Record<Status, string> = { done: '✓', doing: '●', todo: '○', risk: '!' }

const readPipeline = (input: unknown): Pipeline | string => {
  const raw = record(input)
  const stages: Pipeline['stages'] = []
  for (const one of items(raw.stages).slice(0, 7)) {
    const stage = record(one)
    const name = words(stage.name, 20)
    if (name === undefined) continue
    const jobs: Job[] = []
    for (const each of items(stage.jobs ?? stage.steps).slice(0, 6)) {
      const job = typeof each === 'string' ? { label: each } : record(each)
      const label = words(job.label ?? job.name, 30)
      if (label !== undefined) jobs.push({ label, status: STATUSES.includes(job.status as Status) ? (job.status as Status) : undefined })
    }
    if (jobs.length > 0) stages.push({ name, jobs })
  }
  if (stages.length < 2) return 'stages needs at least two, each a name and jobs (labels, or { label, status })'
  const given = record(raw.labels)

  return {
    title: words(raw.title, 80) ?? 'Pipeline',
    stages,
    labels: {
      done: words(given.done, 16) ?? 'done',
      doing: words(given.doing, 16) ?? 'running',
      todo: words(given.todo, 16) ?? 'waiting',
      risk: words(given.risk, 16) ?? 'failed',
    },
  }
}

const drawPipeline = (ui: UI, pipeline: Pipeline, room: number): any => {
  const count = pipeline.stages.length
  const cell = clamp(Math.floor((room + 5) / count), 14, 28)
  const box = cell - 5
  const most = Math.max(...pipeline.stages.map(stage => stage.jobs.length))
  const canvas = makeCanvas(count * cell, 1 + most * 3)
  const rowOfJob = (at: number): number => 2 + at * 3
  pipeline.stages.forEach((stage, index) => {
    const x = index * cell
    put(canvas, x, 0, clip(stage.name, box), { color: tint(index), bold: true })
    stage.jobs.forEach((job, at) => {
      const y = rowOfJob(at)
      const color = job.status ? STATUS_LOOK[job.status].color : tint(index)
      put(canvas, x, y - 1, `╭${'─'.repeat(box - 2)}╮`, { color })
      put(canvas, x, y, `│${' '.repeat(box - 2)}│`, { color })
      put(canvas, x, y + 1, `╰${'─'.repeat(box - 2)}╯`, { color })
      const label = clip(job.status ? `${JOB_MARK[job.status]} ${job.label}` : job.label, box - 2)
      put(canvas, x + 1, y, label, { color: job.status === 'todo' ? 'inactive' : undefined, bold: job.status !== 'todo' })
    })
    const next = pipeline.stages[index + 1]
    if (!next) return
    // Every job of a stage feeds one bus, and the bus feeds every job of the next.
    const layer = makeCanvas(canvas.w, canvas.h)
    const bus = x + box + 2
    stage.jobs.forEach((_, at) => hline(layer, rowOfJob(at), x + box, bus))
    next.jobs.forEach((_, at) => hline(layer, rowOfJob(at), bus, x + cell - 2))
    vline(layer, bus, rowOfJob(0), rowOfJob(Math.max(stage.jobs.length, next.jobs.length) - 1))
    stamp(canvas, layer, WIRE)
    next.jobs.forEach((_, at) => put(canvas, x + cell - 1, rowOfJob(at), '▶', WIRE))
  })
  const used = STATUSES.filter(status => pipeline.stages.some(stage => stage.jobs.some(job => job.status === status)))

  return [
    ...drawRows(ui, rowsOf(canvas)),
    legendOf(ui, used.map(status => `${JOB_MARK[status]} ${pipeline.labels[status]}`), used.map(status => STATUS_LOOK[status].color), 1),
  ]
}

// ---------------------------------------------------------------- gitgraph
// Branches as lanes, time left to right: commits, where a branch forks, where
// it merges back, and the tags along the way.

type GitEvent = { branch: number; label?: string; merge?: number; tag?: string }
type GitGraph = { title: string; branches: { name: string; from: number }[]; events: GitEvent[] }

const readGitGraph = (input: unknown): GitGraph | string => {
  const raw = record(input)
  const branches: GitGraph['branches'] = []
  const laneOf = (value: unknown, from?: unknown): number | undefined => {
    const name = words(value, 20)
    if (name === undefined) return undefined
    const at = branches.findIndex(branch => branch.name === name)
    if (at !== -1) return at
    if (branches.length >= 6) return undefined
    const parent = branches.findIndex(branch => branch.name === words(from, 20))
    branches.push({ name, from: Math.max(0, parent) })

    return branches.length - 1
  }
  for (const one of items(raw.branches)) {
    const branch = typeof one === 'string' ? { name: one } : record(one)
    laneOf(branch.name, branch.from)
  }
  const events: GitEvent[] = []
  for (const one of items(raw.events).slice(0, 24)) {
    const event = record(one)
    const branch = laneOf(event.branch, event.from)
    if (branch === undefined) continue
    events.push({ branch, label: words(event.label, 24), merge: event.merge === undefined ? undefined : laneOf(event.merge), tag: words(event.tag, 12) })
  }
  if (events.length < 2) return 'events needs at least two, in time order: { branch, label, merge (a branch merged in), tag }'

  return { title: words(raw.title, 80) ?? 'Branches', branches, events }
}

const drawGitGraph = (ui: UI, git: GitGraph, room: number): any => {
  const nameW = clamp(Math.max(...git.branches.map(branch => widthOf(branch.name))), 4, 14) + 2
  const cell = clamp(Math.floor((room - nameW) / git.events.length), 4, 12)
  const canvas = makeCanvas(nameW + git.events.length * cell + 14, git.branches.length * 3)
  const colOf = (at: number): number => nameW + at * cell + (cell >> 1)
  const rowOfLane = (lane: number): number => lane * 3 + 1
  git.branches.forEach((branch, lane) => {
    const mine = git.events.map((event, at) => ({ event, at })).filter(one => one.event.branch === lane || one.event.merge === lane)
    const first = lane === 0 ? 0 : (mine[0]?.at ?? 0)
    const last = mine[mine.length - 1]?.at ?? first
    const y = rowOfLane(lane)
    const layer = makeCanvas(canvas.w, canvas.h)
    const fork = colOf(first) - (cell >> 1)
    hline(layer, y, lane === 0 ? colOf(0) : fork, colOf(last))
    if (lane > 0) {
      vline(layer, fork, rowOfLane(branch.from), y)
      wire(layer, fork, rowOfLane(branch.from), LEFT | RIGHT)
    }
    for (const one of mine) {
      if (one.event.merge === lane) vline(layer, colOf(one.at), y, rowOfLane(one.event.branch))
    }
    stamp(canvas, layer, { color: tint(lane) })
    put(canvas, 0, y, clip(branch.name, nameW - 1), { color: tint(lane), bold: true })
  })
  git.events.forEach((event, at) => {
    const x = colOf(at)
    const y = rowOfLane(event.branch)
    put(canvas, x, y, '●', { color: tint(event.branch), bold: true })
    if (event.label !== undefined) {
      const text = clip(event.label, Math.max(4, cell * 2 - 2))
      const left = [x - 1, x + 2 - widthOf(text)].find(spot => isFree(canvas, spot, y - 1, widthOf(text)))
      if (left !== undefined) put(canvas, left, y - 1, text, { dim: true })
    }
    if (event.tag !== undefined && isFree(canvas, x - 1, y + 1, widthOf(event.tag) + 2)) {
      put(canvas, x - 1, y + 1, `◆ ${event.tag}`, { color: 'warning' })
    }
  })

  return drawRows(ui, rowsOf(canvas))
}

// ---------------------------------------------------------------- sequence

type Message = { from: number; to: number; label: string; isReply: boolean }
type Sequence = { title: string; actors: string[]; messages: Message[] }

const readSequence = (input: unknown): Sequence | string => {
  const raw = record(input)
  const actors: string[] = []
  const actorOf = (value: unknown): number | undefined => {
    const name = words(typeof value === 'object' ? record(value).name : value, 24)
    if (name === undefined) return undefined
    const at = actors.indexOf(name)
    if (at !== -1) return at
    if (actors.length >= 7) return undefined
    actors.push(name)

    return actors.length - 1
  }
  items(raw.actors).forEach(actorOf)
  const messages: Message[] = []
  for (const one of items(raw.messages).slice(0, 24)) {
    const message = record(one)
    const from = actorOf(message.from)
    const to = actorOf(message.to)
    if (from === undefined || to === undefined) continue
    messages.push({ from, to, label: words(message.label, 60) ?? '', isReply: message.isReply === true })
  }
  if (actors.length < 2 || messages.length === 0) {
    return 'a sequence needs at least two actors and one message between actors'
  }

  return { title: words(raw.title, 80) ?? 'Sequence', actors, messages }
}

const drawSequence = (ui: UI, sequence: Sequence, room: number): any => {
  const count = sequence.actors.length
  const column = clamp(Math.floor(room / count), 12, 30)
  const xs = sequence.actors.map((_, index) => index * column + (column >> 1))
  const canvas = makeCanvas(count * column, 3 + sequence.messages.length * 2 + 1)
  sequence.actors.forEach((name, index) => {
    const x = xs[index] ?? 0
    const label = clip(name, column - 4)
    const box = widthOf(label) + 2
    const left = x - ((box + 2) >> 1)
    const border: Style = { color: tint(index) }
    put(canvas, left, 0, `╭${'─'.repeat(box)}╮`, border)
    put(canvas, left, 1, '│', border)
    put(canvas, left + 1 + ((box - widthOf(label)) >> 1), 1, label, { bold: true })
    put(canvas, left + box + 1, 1, '│', border)
    put(canvas, left, 2, `╰${'─'.repeat(box)}╯`, border)
    put(canvas, x, 2, '┬', border)
    vline(canvas, x, 3, canvas.h - 1)
  })
  sequence.messages.forEach((message, index) => {
    const y = 3 + index * 2
    const a = xs[message.from] ?? 0
    const b = xs[message.to] ?? 0
    const style: Style = { color: tint(message.from) }
    if (a === b) {
      put(canvas, a + 2, y + 1, clip(`↺ ${message.label}`, column - 3), style)

      return
    }
    const step = b > a ? 1 : -1
    for (let x = a + step; x !== b; x += step) put(canvas, x, y + 1, message.isReply ? '╌' : '─', style)
    put(canvas, b - step, y + 1, step > 0 ? '▶' : '◀', style)
    put(canvas, a, y + 1, step > 0 ? '├' : '┤', WIRE)
    const label = clip(message.label, Math.abs(b - a) - 2)
    const left = Math.min(a, b) + 1 + ((Math.abs(b - a) - 1 - widthOf(label)) >> 1)
    put(canvas, left, y, label, message.isReply ? { dim: true } : {})
  })

  return drawRows(ui, rowsOf(canvas))
}

// ---------------------------------------------------------------- tree

type Branch = { label: string; note?: string; children: Branch[] }
type Tree = { title: string; layout: 'list' | 'mindmap'; root: Branch; count: number }

const readTree = (input: unknown): Tree | string => {
  const raw = record(input)
  let left = 90
  const read = (value: unknown, depth: number): Branch | undefined => {
    const node = typeof value === 'string' ? { label: value } : record(value)
    const label = words(node.label ?? node.name, 60)
    if (label === undefined || left <= 0) return undefined
    left--

    return {
      label,
      note: words(node.note, 60),
      children:
        depth >= 7
          ? []
          : items(node.children)
              .map(child => read(child, depth + 1))
              .filter((child): child is Branch => child !== undefined),
    }
  }
  const root = read(raw.root ?? raw, 0)
  if (!root) return 'root needs a label, and children: a list of the same shape'

  return {
    title: words(raw.title, 80) ?? root.label,
    layout: pick(raw.layout, ['list', 'mindmap'] as const, 'list'),
    root,
    count: 90 - left,
  }
}

type Twig = { node: Branch; depth: number; row: number; branch: number; kids: Twig[] }

// Root at the left, branches spreading right, each main branch in its color.
const drawMind = (ui: UI, tree: Tree, room: number): any => {
  let next = 0
  const lay = (node: Branch, depth: number, branch: number): Twig => {
    const kids = node.children.map((child, index) => lay(child, depth + 1, depth === 0 ? index : branch))
    const first = kids[0]
    const last = kids[kids.length - 1]

    return { node, depth, branch, kids, row: first && last ? (first.row + last.row) >> 1 : next++ }
  }
  const root = lay(tree.root, 0, 0)
  const all: Twig[] = []
  const gather = (twig: Twig): void => {
    all.push(twig)
    twig.kids.forEach(gather)
  }
  gather(root)
  const depths = Math.max(...all.map(twig => twig.depth)) + 1
  for (const cap of [30, 22, 16, 11]) {
    const textOf = (twig: Twig): string =>
      clip(twig.node.note === undefined ? twig.node.label : `${twig.node.label} (${twig.node.note})`, cap)
    const wide = Array.from({ length: depths }, (_, depth) =>
      Math.max(0, ...all.filter(twig => twig.depth === depth).map(twig => widthOf(textOf(twig)))),
    )
    const lefts: number[] = []
    let x = 0
    wide.forEach((size, depth) => {
      lefts[depth] = x
      x += size + 5
    })
    if (x - 5 > room) continue
    const canvas = makeCanvas(x, next)
    for (const twig of all) {
      const left = lefts[twig.depth] ?? 0
      const text = textOf(twig)
      const color = twig.depth === 0 ? 'claude' : tint(twig.branch)
      put(canvas, left, twig.row, text, { color: twig.depth < 2 ? color : undefined, bold: twig.depth < 2 })
      const first = twig.kids[0]
      const last = twig.kids[twig.kids.length - 1]
      if (!first || !last) continue
      const trunk = left + (wide[twig.depth] ?? 0) + 2
      const stem: Style = { color: twig.depth === 0 ? 'inactive' : color }
      hline(canvas, twig.row, left + widthOf(text) + 1, trunk, stem)
      vline(canvas, trunk, first.row, last.row, stem)
      for (const kid of twig.kids) {
        hline(canvas, kid.row, trunk, (lefts[kid.depth] ?? 0) - 2, { color: tint(kid.branch) })
      }
    }

    return drawRows(ui, rowsOf(canvas))
  }

  return undefined
}

const drawTree = (ui: UI, tree: Tree, room: number): any => {
  const mind = tree.layout === 'mindmap' ? drawMind(ui, tree, room) : undefined
  if (mind !== undefined) return mind
  const lines: any[] = []
  const walk = (node: Branch, prefix: string, branch: string, depth: number): void => {
    const lead = prefix + branch
    const indent = lead.length - lead.trimStart().length
    const stem = lead.trimStart()
    lines.push(
      <ui.Box flexDirection="row" paddingLeft={indent} width={room}>
        {stem !== '' && <ui.Text color="inactive">{stem}</ui.Text>}
        <ui.Text bold={depth < 2} {...(depth === 0 && { color: 'claude' })} wrap="truncate-end">
          {node.label}
        </ui.Text>
        {node.note !== undefined && (
          <ui.Box marginLeft={2} flexShrink={1}>
            <ui.Text dimColor wrap="truncate-end">
              {node.note}
            </ui.Text>
          </ui.Box>
        )}
      </ui.Box>,
    )
    node.children.forEach((child, index) => {
      const isLast = index === node.children.length - 1
      walk(child, prefix + (depth === 0 ? '' : branch.startsWith('└') ? '   ' : '│  '), isLast ? '└─ ' : '├─ ', depth + 1)
    })
  }
  walk(tree.root, '', '', 0)

  return lines
}

// ---------------------------------------------------------------- timeline

type Status = 'done' | 'doing' | 'todo' | 'risk'
type Task = { name: string; from: number; to: number; status: Status; group?: string }
type Timeline = {
  title: string
  periods: string[]
  tasks: Task[]
  milestones: { name: string; at: number }[]
  labels: Record<Status, string>
}

const STATUSES: readonly Status[] = ['done', 'doing', 'todo', 'risk']
const STATUS_LOOK: Record<Status, { char: string; color: string }> = {
  done: { char: '█', color: 'success' },
  doing: { char: '▓', color: 'claude' },
  todo: { char: '░', color: 'inactive' },
  risk: { char: '▓', color: 'error' },
}

const readTimeline = (input: unknown): Timeline | string => {
  const raw = record(input)
  const periods = wordList(raw.periods, 18, 16)
  if (periods.length < 2) return 'periods needs at least two labels, in order: Q1, Q2 or Jan, Feb'
  const at = (value: unknown): number | undefined => {
    const name = words(value, 16)
    const index = name === undefined ? -1 : periods.indexOf(name)
    if (index !== -1) return index
    const position = num(value)

    return position === undefined ? undefined : clamp(Math.round(position) - 1, 0, periods.length - 1)
  }
  const tasks: Task[] = []
  for (const one of items(raw.items).slice(0, 24)) {
    const task = record(one)
    const name = words(task.name, 40)
    const from = at(task.from)
    if (name === undefined || from === undefined) continue
    const to = at(task.to) ?? from
    tasks.push({
      name,
      from: Math.min(from, to),
      to: Math.max(from, to),
      status: pick(task.status, STATUSES, 'todo'),
      group: words(task.group, 24),
    })
  }
  if (tasks.length === 0) return 'items is empty: each needs a name and a from that is one of periods'
  const milestones: { name: string; at: number }[] = []
  for (const one of items(raw.milestones).slice(0, 8)) {
    const stone = record(one)
    const name = words(stone.name, 24)
    const where = at(stone.at)
    if (name !== undefined && where !== undefined) milestones.push({ name, at: where })
  }
  const given = record(raw.labels)

  return {
    title: words(raw.title, 80) ?? 'Timeline',
    periods,
    tasks,
    milestones,
    labels: {
      done: words(given.done, 16) ?? 'done',
      doing: words(given.doing, 16) ?? 'doing',
      todo: words(given.todo, 16) ?? 'to do',
      risk: words(given.risk, 16) ?? 'at risk',
    },
  }
}

const drawTimeline = (ui: UI, timeline: Timeline, room: number, played: number): any => {
  const labelW = clamp(Math.max(...timeline.tasks.map(task => widthOf(task.name))), 6, 24)
  const column = clamp(Math.floor((room - labelW - 2) / timeline.periods.length), 3, 14)
  const head = makeCanvas(timeline.periods.length * column, 1)
  timeline.periods.forEach((period, index) => put(head, index * column, 0, clip(period, column - 1), { dim: true }))
  const out: any[] = [<ui.Box paddingLeft={labelW + 1}>{rowOf(ui, rowsOf(head)[0] ?? { indent: 0, segs: [] })}</ui.Box>]
  let group: string | undefined
  for (const task of timeline.tasks) {
    if (task.group !== undefined && task.group !== group) {
      out.push(
        <ui.Text bold color="suggestion">
          {task.group}
        </ui.Text>,
      )
    }
    group = task.group
    const look = STATUS_LOOK[task.status]
    const length = Math.max(1, Math.round(((task.to - task.from + 1) * column - 1) * played))
    out.push(
      <ui.Box flexDirection="row">
        <ui.Box width={labelW + 1} flexShrink={0}>
          <ui.Text wrap="truncate-end">{task.name}</ui.Text>
        </ui.Box>
        <ui.Box paddingLeft={task.from * column}>
          <ui.Text color={look.color}>{look.char.repeat(length)}</ui.Text>
        </ui.Box>
      </ui.Box>,
    )
  }
  if (timeline.milestones.length > 0) {
    const marks = makeCanvas(timeline.periods.length * column + 26, 2)
    const left: string[] = []
    for (const stone of timeline.milestones) {
      const x = stone.at * column + (column >> 1)
      const text = `◆ ${clip(stone.name, 22)}`
      const y = [0, 1].find(row => isFree(marks, x, row, widthOf(text)))
      if (y === undefined) left.push(`◆ ${timeline.periods[stone.at] ?? ''}: ${stone.name}`)
      else put(marks, x, y, text, { color: 'warning' })
    }
    for (const row of rowsOf(marks)) {
      if (row.segs.length > 0) out.push(<ui.Box paddingLeft={labelW + 1}>{rowOf(ui, row)}</ui.Box>)
    }
    for (const line of left) out.push(<ui.Text color="warning">{line}</ui.Text>)
  }
  const used = STATUSES.filter(status => timeline.tasks.some(task => task.status === status))
  out.push(legendOf(ui, used.map(status => timeline.labels[status]), used.map(status => STATUS_LOOK[status].color), 1))

  return out
}

// ---------------------------------------------------------------- board

type Board = { title: string; columns: { name: string; cards: { title: string; meta?: string }[] }[] }

const readBoard = (input: unknown): Board | string => {
  const raw = record(input)
  const columns: Board['columns'] = []
  for (const one of items(raw.columns).slice(0, 6)) {
    const column = record(one)
    const name = words(column.name, 24)
    if (name === undefined) continue
    const cards: { title: string; meta?: string }[] = []
    for (const each of items(column.cards).slice(0, 8)) {
      const card = typeof each === 'string' ? { title: each } : record(each)
      const title = words(card.title ?? card.name, 70)
      if (title !== undefined) cards.push({ title, meta: words(card.meta, 40) })
    }
    columns.push({ name, cards })
  }
  if (columns.length === 0) return 'columns is empty: each needs a name and a list of cards'

  return { title: words(raw.title, 80) ?? 'Board', columns }
}

const drawBoard = (ui: UI, board: Board, room: number): any => {
  const width = clamp(Math.floor(room / board.columns.length) - 1, 16, 36)

  return (
    <ui.Box flexDirection="row" flexWrap="wrap" columnGap={1}>
      {board.columns.map((column, index) => (
        <ui.Box flexDirection="column" width={width}>
          <ui.Text bold color={tint(index)} wrap="truncate-end">
            {`${column.name} · ${column.cards.length}`}
          </ui.Text>
          {column.cards.map(card => (
            <ui.Box borderStyle="round" borderColor={tint(index)} borderDimColor flexDirection="column" paddingX={1} width={width}>
              <ui.Text wrap="wrap">{card.title}</ui.Text>
              {card.meta !== undefined && (
                <ui.Text dimColor wrap="truncate-end">
                  {card.meta}
                </ui.Text>
              )}
            </ui.Box>
          ))}
        </ui.Box>
      ))}
    </ui.Box>
  )
}

// ---------------------------------------------------------------- quadrant

type Quadrant = {
  title: string
  x: [string, string]
  y: [string, string]
  areas: { name?: string; points: string[] }[]
  points: { name: string; x: number; y: number }[]
}

const MARKS = '123456789ABCDEFGHJKLMNPQRSTUVWXYZ'
const AREA_COLORS = ['success', 'suggestion', 'warning', 'error']

const readQuadrant = (input: unknown): Quadrant | string => {
  const raw = record(input)
  const areas = items(raw.areas)
    .slice(0, 4)
    .map(one => {
      const area = typeof one === 'string' ? { name: one } : record(one)

      return { name: words(area.name, 28), points: wordList(area.points, 6, 60) }
    })
  while (areas.length < 4) areas.push({ name: undefined, points: [] })
  const points: Quadrant['points'] = []
  for (const one of items(raw.items).slice(0, MARKS.length)) {
    const point = record(one)
    const name = words(point.name, 40)
    const x = num(point.x)
    const y = num(point.y)
    if (name !== undefined && x !== undefined && y !== undefined) {
      points.push({ name, x: clamp(x, 0, 1), y: clamp(y, 0, 1) })
    }
  }
  if (points.length === 0 && areas.every(area => area.points.length === 0)) {
    return 'give items (each a name with x and y from 0 to 1), or areas with points for four lists'
  }

  return {
    title: words(raw.title, 80) ?? 'Quadrant',
    x: [words(raw.xLow, 24) ?? '', words(raw.xHigh, 24) ?? ''],
    y: [words(raw.yLow, 24) ?? '', words(raw.yHigh, 24) ?? ''],
    areas,
    points,
  }
}

const drawQuadrant = (ui: UI, quadrant: Quadrant, room: number): any => {
  if (quadrant.points.length === 0) {
    const width = clamp(Math.floor(room / 2) - 1, 20, 50)
    const cell = (index: number): any => {
      const area = quadrant.areas[index]
      const color = AREA_COLORS[index] ?? 'text'

      return (
        <ui.Box borderStyle="round" borderColor={color} flexDirection="column" paddingX={1} width={width}>
          <ui.Text bold color={color} wrap="truncate-end">
            {area?.name ?? ' '}
          </ui.Text>
          {(area?.points ?? []).map(point => (
            <ui.Box flexDirection="row" columnGap={1}>
              <ui.Text color={color}>•</ui.Text>
              <ui.Text wrap="wrap">{point}</ui.Text>
            </ui.Box>
          ))}
        </ui.Box>
      )
    }

    return [
      <ui.Box flexDirection="row" columnGap={1}>
        {cell(0)}
        {cell(1)}
      </ui.Box>,
      <ui.Box flexDirection="row" columnGap={1}>
        {cell(2)}
        {cell(3)}
      </ui.Box>,
    ]
  }

  const width = clamp(room - 2, 41, 67) | 1
  const height = 15
  const canvas = makeCanvas(width, height)
  const cx = width >> 1
  const cy = height >> 1
  const corners: [number, number, boolean][] = [
    [1, 0, false],
    [width - 2, 0, true],
    [1, height - 1, false],
    [width - 2, height - 1, true],
  ]
  quadrant.areas.forEach((area, index) => {
    const corner = corners[index]
    if (area.name === undefined || !corner) return
    const text = clip(area.name, cx - 3)
    put(canvas, corner[2] ? corner[0] - widthOf(text) + 1 : corner[0], corner[1], text, { color: AREA_COLORS[index], dim: true })
  })
  hline(canvas, cy, 0, width - 1)
  vline(canvas, cx, 0, height - 1)
  quadrant.points.forEach((point, index) => {
    let x = Math.round(point.x * (width - 1))
    const y = Math.round((1 - point.y) * (height - 1))
    while (x < width - 1 && MARKS.includes(cellAt(canvas, x, y)?.ch || ' ') && cellAt(canvas, x, y)?.bold) x++
    put(canvas, x, y, MARKS[index] ?? '•', { color: tint(index), bold: true })
  })

  return [
    quadrant.y[1] !== '' && <ui.Text dimColor>{`▲ ${quadrant.y[1]}`}</ui.Text>,
    ...drawRows(ui, rowsOf(canvas)),
    quadrant.y[0] !== '' && <ui.Text dimColor>{`▼ ${quadrant.y[0]}`}</ui.Text>,
    <ui.Box flexDirection="row" justifyContent="space-between" width={width}>
      <ui.Text dimColor>{`◀ ${quadrant.x[0]}`}</ui.Text>
      <ui.Text dimColor>{`${quadrant.x[1]} ▶`}</ui.Text>
    </ui.Box>,
    <ui.Box flexDirection="row" flexWrap="wrap" columnGap={3}>
      {quadrant.points.map((point, index) => (
        <ui.Box flexDirection="row" columnGap={1}>
          <ui.Text bold color={tint(index)}>
            {MARKS[index] ?? '•'}
          </ui.Text>
          <ui.Text>{point.name}</ui.Text>
        </ui.Box>
      ))}
    </ui.Box>,
  ]
}

// ---------------------------------------------------------------- journey

type Journey = {
  title: string
  who?: string
  moodLabel: string
  stages: { name: string; mood: number }[]
  rows: { name: string; tone: string; cells: string[] }[]
}

const readJourney = (input: unknown): Journey | string => {
  const raw = record(input)
  const stages: Journey['stages'] = []
  for (const one of items(raw.stages).slice(0, 7)) {
    const stage = typeof one === 'string' ? { name: one } : record(one)
    const name = words(stage.name, 24)
    if (name !== undefined) stages.push({ name, mood: clamp(Math.round(num(stage.mood) ?? 3), 1, 5) })
  }
  if (stages.length < 2) return 'stages needs at least two, each a name and a mood from 1 (worst) to 5 (best)'
  const rows: Journey['rows'] = []
  for (const one of items(raw.rows).slice(0, 5)) {
    const row = record(one)
    const name = words(row.name, 14)
    if (name === undefined) continue
    rows.push({
      name,
      tone: pick(row.tone, ['good', 'bad', 'warn', 'plain'] as const, 'plain'),
      cells: stages.map((_, index) => words(items(row.cells)[index], 80) ?? ''),
    })
  }

  return {
    title: words(raw.title, 80) ?? 'Journey',
    who: words(raw.who, 80),
    moodLabel: words(raw.moodLabel, 12) ?? 'mood',
    stages,
    rows,
  }
}

const moodColor = (mood: number): string => (mood <= 2 ? 'error' : mood === 3 ? 'warning' : 'success')

const drawJourney = (ui: UI, journey: Journey, room: number, played: number): any => {
  const count = journey.stages.length
  const labelW = clamp(Math.max(widthOf(journey.moodLabel), ...journey.rows.map(row => widthOf(row.name))), 4, 12) + 1
  const column = clamp(Math.floor((room - labelW) / count), 10, 28)
  const centers = journey.stages.map((_, index) => index * column + (column >> 1))
  const first = centers[0] ?? 0
  const last = centers[count - 1] ?? 0
  const curve = makeCanvas(count * column, 5)
  const rows = Array.from({ length: count * column }, (_, x) => {
    if (x < first || x > last) return undefined
    const at = (x - first) / column
    const before = journey.stages[Math.floor(at)]?.mood ?? 3
    const after = journey.stages[Math.min(count - 1, Math.floor(at) + 1)]?.mood ?? before

    return Math.round(5 - (before + (after - before) * (at - Math.floor(at))))
  })
  const layer = makeCanvas(count * column, 5)
  trace(layer, rows, Math.round(first + (last - first) * played))
  stamp(curve, layer, { color: 'inactive' })
  journey.stages.forEach((stage, index) => {
    put(curve, centers[index] ?? 0, 5 - stage.mood, '●', { color: moodColor(stage.mood), bold: true })
  })
  const lane = (label: any, cells: any[]): any => (
    <ui.Box flexDirection="row">
      <ui.Box width={labelW} flexShrink={0}>
        {label}
      </ui.Box>
      {cells}
    </ui.Box>
  )

  return [
    journey.who !== undefined && <ui.Text dimColor>{journey.who}</ui.Text>,
    lane(
      <ui.Text>{' '}</ui.Text>,
      journey.stages.map((stage, index) => (
        <ui.Box width={column} flexShrink={0}>
          <ui.Text bold color={tint(index)} wrap="truncate-end">
            {clip(`${index + 1} ${stage.name}`, column - 1)}
          </ui.Text>
        </ui.Box>
      )),
    ),
    ...rowsOf(curve).map((row, index) =>
      lane(index === 2 ? <ui.Text dimColor>{journey.moodLabel}</ui.Text> : <ui.Text>{' '}</ui.Text>, [rowOf(ui, row)]),
    ),
    ...journey.rows.map(row =>
      lane(
        <ui.Text dimColor bold wrap="truncate-end">
          {row.name}
        </ui.Text>,
        row.cells.map(cell => (
          <ui.Box width={column} flexShrink={0} paddingRight={1}>
            <ui.Text {...(row.tone !== 'plain' && { color: TONES[row.tone] })} wrap="wrap">
              {cell === '' ? ' ' : cell}
            </ui.Text>
          </ui.Box>
        )),
      ),
    ),
  ]
}

// ---------------------------------------------------------------- wireframe

type Frame = {
  type: 'row' | 'column' | 'box'
  kind: string
  label?: string
  size: number
  lines: number
  children: Frame[]
}
type Wireframe = { title: string; isNarrow: boolean; screen: Frame; count: number }

const readWireframe = (input: unknown): Wireframe | string => {
  const raw = record(input)
  let left = 48
  const read = (value: unknown, depth: number): Frame | undefined => {
    if (left <= 0 || depth > 6) return undefined
    const node = typeof value === 'string' ? { label: value } : record(value)
    left--
    const children = items(node.children)
      .map(child => read(child, depth + 1))
      .filter((child): child is Frame => child !== undefined)
    const label = words(node.label, 60)

    return {
      type: node.type === 'row' || node.type === 'column' ? node.type : children.length > 0 ? 'column' : 'box',
      kind: words(node.kind, 16) ?? (label === undefined ? 'text' : 'label'),
      label,
      size: clamp(num(node.size) ?? 1, 0.2, 12),
      lines: clamp(Math.round(num(node.lines) ?? 0), 0, 8),
      children,
    }
  }
  const screen = read(raw.screen, 0)
  if (!screen || (screen.children.length === 0 && screen.label === undefined)) {
    return 'screen needs children: nested { type: "row" | "column", children } and boxes { kind, label }'
  }

  return {
    title: words(raw.title, 80) ?? 'Wireframe',
    isNarrow: raw.device === 'mobile',
    screen,
    count: 48 - left,
  }
}

const drawFrame = (ui: UI, frame: Frame, width: number): any => {
  const caption = frame.label !== undefined && frame.children.length > 0 && (
    <ui.Text dimColor wrap="truncate-end">
      {frame.label}
    </ui.Text>
  )
  if (frame.children.length > 0 && frame.type === 'row') {
    const count = frame.children.length
    const free = Math.max(count * 6, width - (count - 1))
    const total = frame.children.reduce((sum, child) => sum + child.size, 0)
    let used = 0

    return (
      <ui.Box flexDirection="column" width={width}>
        {caption}
        <ui.Box flexDirection="row" columnGap={1}>
          {frame.children.map((child, index) => {
            const share = index === count - 1 ? free - used : Math.floor((free * child.size) / total)
            const size = Math.max(6, share)
            used += size

            return drawFrame(ui, child, size)
          })}
        </ui.Box>
      </ui.Box>
    )
  }
  if (frame.children.length > 0) {
    return (
      <ui.Box flexDirection="column" width={width}>
        {caption}
        {frame.children.map(child => drawFrame(ui, child, width))}
      </ui.Box>
    )
  }

  const inner = Math.max(2, width - 4)
  const label = frame.label
  if (frame.kind === 'button') {
    return (
      <ui.Box width={width} justifyContent="center">
        <ui.Text inverse bold wrap="truncate-end">
          {`[ ${clip(label ?? 'OK', Math.max(2, width - 4))} ]`}
        </ui.Text>
      </ui.Box>
    )
  }
  const bars = (count: number, lead: string): any[] =>
    Array.from({ length: count }, (_, index) => (
      <ui.Text dimColor wrap="truncate-end">
        {lead + '━'.repeat(Math.max(2, Math.round((inner - widthOf(lead)) * (index % 2 === 0 ? 1 : 0.6))))}
      </ui.Text>
    ))
  const blank = (count: number): any[] => Array.from({ length: count }, () => <ui.Text>{' '}</ui.Text>)
  let body: any
  if (frame.kind === 'image' || frame.kind === 'video' || frame.kind === 'map' || frame.kind === 'chart') {
    const tall = Math.max(1, frame.lines === 0 ? 3 : frame.lines)
    const above = (tall - 1) >> 1
    body = [
      ...blank(above),
      <ui.Box justifyContent="center">
        <ui.Text dimColor wrap="truncate-end">{`▨ ${label ?? frame.kind}`}</ui.Text>
      </ui.Box>,
      ...blank(tall - 1 - above),
    ]
  } else if (frame.kind === 'heading' || frame.kind === 'title') {
    body = (
      <ui.Text bold wrap="truncate-end">
        {label ?? '━━━━━━'}
      </ui.Text>
    )
  } else if (frame.kind === 'input' || frame.kind === 'search') {
    body = (
      <ui.Text dimColor italic wrap="truncate-end">
        {`${label ?? ''}▏`}
      </ui.Text>
    )
  } else if (frame.kind === 'nav' || frame.kind === 'tabs') {
    const tabs = (label ?? 'Home | …').split(/\s*[|,、]\s*/).filter(tab => tab !== '')
    body = (
      <ui.Box flexDirection="row" columnGap={2}>
        {tabs.map((tab, index) => (
          <ui.Text bold={index === 0} underline={index === 0} dimColor={index !== 0} wrap="truncate-end">
            {tab}
          </ui.Text>
        ))}
      </ui.Box>
    )
  } else if (frame.kind === 'list') {
    body = [
      label !== undefined && (
        <ui.Text bold wrap="truncate-end">
          {label}
        </ui.Text>
      ),
      ...bars(frame.lines === 0 ? 3 : frame.lines, '• '),
    ]
  } else if (frame.kind === 'text') {
    body = [
      label !== undefined && <ui.Text wrap="wrap">{label}</ui.Text>,
      ...bars(frame.lines === 0 ? (label === undefined ? 2 : 0) : frame.lines, ''),
    ]
  } else {
    body = [<ui.Text wrap="wrap">{label ?? ' '}</ui.Text>, ...bars(frame.lines, '')]
  }

  return (
    <ui.Box borderStyle="single" borderColor="inactive" flexDirection="column" paddingX={1} width={width}>
      {body}
    </ui.Box>
  )
}

const drawWireframe = (ui: UI, wireframe: Wireframe, room: number): any => {
  const width = wireframe.isNarrow ? Math.min(room - 4, 40) : Math.min(room - 4, 104)

  return (
    <ui.Box borderStyle="round" borderColor="suggestion" flexDirection="column" paddingX={1} width={width + 4}>
      {drawFrame(ui, wireframe.screen, width)}
    </ui.Box>
  )
}

// ---------------------------------------------------------------- metrics

type Tile = { label: string; value: string; delta?: string; tone: string; series: number[]; note?: string }
type Metrics = { title: string; tiles: Tile[] }

const SPARKS = '▁▂▃▄▅▆▇█'

const sparkOf = (series: number[], width: number, played: number): string => {
  if (series.length < 2) return ''
  const size = Math.min(width, series.length)
  const picked = Array.from({ length: size }, (_, index) =>
    series[Math.round((index * (series.length - 1)) / Math.max(1, size - 1))] ?? 0,
  )
  const low = Math.min(...picked)
  const high = Math.max(...picked)

  return picked
    .slice(0, Math.max(1, Math.ceil(size * played)))
    .map(value => SPARKS[high === low ? 3 : Math.round(((value - low) / (high - low)) * 7)] ?? '▁')
    .join('')
}

const readMetrics = (input: unknown): Metrics | string => {
  const raw = record(input)
  const tiles: Tile[] = []
  for (const one of items(raw.tiles).slice(0, 8)) {
    const tile = record(one)
    const label = words(tile.label, 30)
    const value = words(tile.value, 20)
    if (label === undefined || value === undefined) continue
    tiles.push({
      label,
      value,
      delta: words(tile.delta, 24),
      tone: pick(tile.tone, ['good', 'bad', 'warn', 'plain'] as const, 'plain'),
      series: numbers(tile.series, 120),
      note: words(tile.note, 40),
    })
  }
  if (tiles.length === 0) return 'tiles is empty: each needs a label and a value'

  return { title: words(raw.title, 80) ?? 'Metrics', tiles }
}

const drawMetrics = (ui: UI, metrics: Metrics, room: number, played: number): any => {
  const width = clamp(Math.floor(room / Math.min(metrics.tiles.length, 4)) - 1, 18, 32)

  return (
    <ui.Box flexDirection="row" flexWrap="wrap" columnGap={1}>
      {metrics.tiles.map(tile => {
        const color = TONES[tile.tone] ?? 'text'
        const spark = sparkOf(tile.series, width - 4, played)

        return (
          <ui.Box borderStyle="round" borderColor="inactive" flexDirection="column" paddingX={1} width={width}>
            <ui.Text dimColor wrap="truncate-end">
              {tile.label}
            </ui.Text>
            <ui.Text bold wrap="truncate-end">
              {tile.value}
            </ui.Text>
            {tile.delta !== undefined && (
              <ui.Text color={color} wrap="truncate-end">
                {tile.delta}
              </ui.Text>
            )}
            {spark !== '' && <ui.Text color={tile.tone === 'plain' ? 'suggestion' : color}>{spark}</ui.Text>}
            {tile.note !== undefined && (
              <ui.Text dimColor wrap="truncate-end">
                {tile.note}
              </ui.Text>
            )}
          </ui.Box>
        )
      })}
    </ui.Box>
  )
}

// ---------------------------------------------------------------- chart

const CHART_KINDS = ['bar', 'column', 'stacked', 'line', 'scatter', 'heatmap', 'histogram', 'funnel', 'share'] as const
type ChartKind = (typeof CHART_KINDS)[number]
type Series = { name: string; values: number[] }
type Chart = {
  kind: ChartKind
  title: string
  unit: string
  labels: string[]
  series: Series[]
  points: { x: number; y: number }[]
  xLabel?: string
  yLabel?: string
  bins: number
  edges?: [string, string]
}

const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']
const LEVELS = ' ▁▂▃▄▅▆▇█'
const SHADES = '·░▒▓█'

const readChart = (input: unknown): Chart | string => {
  const raw = record(input)
  const kind = pick(raw.kind, CHART_KINDS, 'bar')
  let series: Series[] = []
  for (const one of items(raw.series).slice(0, 12)) {
    const each = record(one)
    const values = numbers(each.values, 400)
    if (values.length > 0) series.push({ name: words(each.name, 24) ?? `#${series.length + 1}`, values })
  }
  const flat = numbers(raw.values, 2000)
  if (series.length === 0 && flat.length > 0) series = [{ name: words(raw.name, 24) ?? '', values: flat }]
  const points: Chart['points'] = []
  for (const one of items(raw.points).slice(0, 600)) {
    const point = record(one)
    const x = num(point.x)
    const y = num(point.y)
    if (x !== undefined && y !== undefined) points.push({ x, y })
  }
  if (kind === 'scatter' ? points.length === 0 : series.length === 0) {
    return kind === 'scatter'
      ? 'a scatter needs points: [{ x, y }]'
      : `a ${kind} chart needs series: [{ name, values: [numbers] }] beside labels`
  }
  let labels = wordList(raw.labels, 60, 24)
  let edges: [string, string] | undefined
  if (kind === 'histogram') {
    const values = series[0]?.values ?? []
    const low = Math.min(...values)
    const high = Math.max(...values)
    const bins = clamp(Math.round(num(raw.bins) ?? Math.sqrt(values.length)), 4, 30)
    const counts = new Array<number>(bins).fill(0)
    for (const value of values) {
      const at = high === low ? 0 : Math.min(bins - 1, Math.floor(((value - low) / (high - low)) * bins))
      counts[at] = (counts[at] ?? 0) + 1
    }
    series = [{ name: series[0]?.name ?? '', values: counts }]
    labels = counts.map(() => '')
    edges = [fmt(low), fmt(high)]
  }

  return {
    kind,
    title: words(raw.title, 80) ?? 'Chart',
    unit: words(raw.unit, 8) ?? '',
    labels,
    series,
    points,
    xLabel: words(raw.xLabel, 30),
    yLabel: words(raw.yLabel, 30),
    bins: 0,
    edges,
  }
}

const blocks = (length: number): string => {
  const whole = Math.floor(length)
  const part = Math.round((length - whole) * 8)

  return part === 8 ? '█'.repeat(whole + 1) : '█'.repeat(whole) + (EIGHTHS[part] ?? '')
}

const labelAt = (chart: Chart, index: number): string => chart.labels[index] ?? String(index + 1)

const aside = (ui: UI, text: string): any => (
  <ui.Box marginLeft={1} flexShrink={0}>
    <ui.Text dimColor>{text}</ui.Text>
  </ui.Box>
)

const drawBars = (ui: UI, chart: Chart, room: number, played: number): any => {
  const count = Math.min(30, Math.max(...chart.series.map(series => series.values.length)))
  const labelW = clamp(Math.max(...Array.from({ length: count }, (_, index) => widthOf(labelAt(chart, index)))), 3, 22)
  const width = Math.max(10, room - labelW - 12)
  const isStacked = chart.kind === 'stacked'
  const totals = Array.from({ length: count }, (_, index) =>
    chart.series.reduce((sum, series) => sum + Math.max(0, series.values[index] ?? 0), 0),
  )
  const top = Math.max(
    1e-9,
    ...(isStacked ? totals : chart.series.flatMap(series => series.values.slice(0, count).map(value => Math.max(0, value)))),
  )
  const label = (text: string): any => (
    <ui.Box width={labelW + 1} flexShrink={0}>
      <ui.Text wrap="truncate-end">{text}</ui.Text>
    </ui.Box>
  )
  const out: any[] = []
  for (let index = 0; index < count; index++) {
    if (isStacked) {
      out.push(
        <ui.Box flexDirection="row">
          {label(labelAt(chart, index))}
          {chart.series.map((series, at) => {
            const cells = Math.round((Math.max(0, series.values[index] ?? 0) / top) * width * played)

            return cells > 0 && <ui.Text color={tint(at)}>{'█'.repeat(cells)}</ui.Text>
          })}
          {aside(ui, `${fmt(totals[index] ?? 0)}${chart.unit}`)}
        </ui.Box>,
      )
      continue
    }
    chart.series.forEach((series, at) => {
      const value = series.values[index]
      if (value === undefined) return
      out.push(
        <ui.Box flexDirection="row">
          {label(at === 0 ? labelAt(chart, index) : ' ')}
          <ui.Text color={tint(at)}>{blocks((Math.max(0, value) / top) * width * played) || '▏'}</ui.Text>
          {aside(ui, `${fmt(value)}${chart.unit}`)}
        </ui.Box>,
      )
    })
  }
  out.push(legendOf(ui, chart.series.map(series => series.name), chart.series.map((_, at) => tint(at))))

  return out
}

const AXIS = 8

const axisRows = (ui: UI, rows: Row[], high: string, low: string, mid = ' '): any[] =>
  rows.map((row, index) => {
    const isTick = index === 0 || index === rows.length - 1 || (mid !== ' ' && index === rows.length >> 1)

    return (
      <ui.Box flexDirection="row">
        <ui.Box width={AXIS} flexShrink={0} justifyContent="flex-end">
          <ui.Text dimColor wrap="truncate-end">
            {index === 0 ? high : index === rows.length - 1 ? low : index === rows.length >> 1 ? mid : ' '}
          </ui.Text>
        </ui.Box>
        <ui.Text color="inactive">{isTick ? '┤' : '│'}</ui.Text>
        {rowOf(ui, row)}
      </ui.Box>
    )
  })

const floorOf = (ui: UI, width: number, marks: [number, string][]): any[] => {
  const canvas = makeCanvas(width, 1)
  for (const [x, text] of marks) {
    const cut = clip(text, 16)
    const at = clamp(x - (widthOf(cut) >> 1), 0, Math.max(0, width - widthOf(cut)))
    if (cut !== '' && isFree(canvas, at, 0, widthOf(cut))) put(canvas, at, 0, cut, { dim: true })
  }

  return [
    <ui.Box paddingLeft={AXIS}>
      <ui.Text color="inactive">{`└${'─'.repeat(width)}`}</ui.Text>
    </ui.Box>,
    <ui.Box paddingLeft={AXIS + 1}>{rowOf(ui, rowsOf(canvas)[0] ?? { indent: 0, segs: [] })}</ui.Box>,
  ]
}

const drawColumns = (ui: UI, chart: Chart, room: number, played: number): any => {
  const count = Math.min(chart.kind === 'histogram' ? 30 : 24, Math.max(...chart.series.map(series => series.values.length)))
  const each = chart.series.length
  const plot = Math.max(12, room - AXIS - 2)
  const bar = clamp(Math.floor((Math.floor(plot / count) - 1) / each), 1, 6)
  const group = bar * each + 1
  const tall = 8
  const top = Math.max(
    1e-9,
    ...chart.series.flatMap(series => series.values.slice(0, count).map(value => Math.max(0, value))),
  )
  const canvas = makeCanvas(count * group, tall + 1)
  for (let index = 0; index < count; index++) {
    chart.series.forEach((series, at) => {
      const value = Math.max(0, series.values[index] ?? 0)
      const eighths = Math.round((value / top) * tall * 8 * played)
      for (let row = 0; row < tall; row++) {
        const level = clamp(eighths - row * 8, 0, 8)
        if (level > 0) {
          put(canvas, index * group + at * bar, tall - row, (LEVELS[level] ?? '█').repeat(bar), { color: tint(at) })
        }
      }
      if (each === 1 && bar >= 2 && eighths > 0) {
        const text = clip(fmt(series.values[index] ?? 0), group)
        const y = tall - Math.ceil(eighths / 8)
        if (y >= 0 && widthOf(text) <= group) put(canvas, index * group, y, text, { dim: true })
      }
    })
  }
  const marks: [number, string][] = chart.edges
    ? [
        [0, `${chart.edges[0]}${chart.unit}`],
        [count * group, `${chart.edges[1]}${chart.unit}`],
      ]
    : Array.from({ length: count }, (_, index) => [index * group + (group >> 1), clip(labelAt(chart, index), Math.max(1, group - 1))])

  return [
    ...axisRows(ui, rowsOf(canvas), chart.edges ? fmt(top) : `${fmt(top)}${chart.unit}`, '0'),
    ...floorOf(ui, count * group, marks),
    legendOf(ui, chart.series.map(series => series.name), chart.series.map((_, at) => tint(at))),
  ]
}

const drawPlot = (ui: UI, chart: Chart, room: number, played: number): any => {
  const width = clamp(room - AXIS - 2, 20, 110)
  if (chart.kind === 'scatter') {
    const tall = 12
    const canvas = makeCanvas(width, tall)
    const count = chart.points.length
    const xs = chart.points.map(point => point.x)
    const ys = chart.points.map(point => point.y)
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
    const colOf = (x: number): number => Math.round(((x - x0) / (x1 - x0 || 1)) * (width - 1))
    const rowAt = (y: number): number => Math.round((1 - (y - y0) / (y1 - y0 || 1)) * (tall - 1))
    // The least-squares line through the points, dotted behind them.
    const meanX = xs.reduce((sum, x) => sum + x, 0) / count
    const meanY = ys.reduce((sum, y) => sum + y, 0) / count
    const spreadX = xs.reduce((sum, x) => sum + (x - meanX) ** 2, 0)
    const spreadY = ys.reduce((sum, y) => sum + (y - meanY) ** 2, 0)
    const together = chart.points.reduce((sum, point) => sum + (point.x - meanX) * (point.y - meanY), 0)
    if (count >= 3 && spreadX > 0 && played === 1) {
      for (let col = 0; col < width; col += 2) {
        const row = rowAt(meanY + (together / spreadX) * (x0 + (col / (width - 1)) * (x1 - x0) - meanX))
        if (row >= 0 && row < tall) put(canvas, col, row, '·', { dim: true })
      }
    }
    chart.points.slice(0, Math.ceil(count * played)).forEach(point => {
      const col = colOf(point.x)
      const row = rowAt(point.y)
      const isStacked = cellAt(canvas, col, row)?.ch === '●'
      put(canvas, col, row, '●', { color: isStacked ? 'warning' : 'claude', bold: true })
    })
    const fit = spreadX > 0 && spreadY > 0 ? `  r=${trimNumber(together / Math.sqrt(spreadX * spreadY), 2)}` : ''

    return [
      chart.yLabel !== undefined && <ui.Text dimColor>{`↑ ${chart.yLabel}`}</ui.Text>,
      ...axisRows(ui, rowsOf(canvas), fmt(y1), fmt(y0), fmt((y0 + y1) / 2)),
      ...floorOf(ui, width, [
        [0, fmt(x0)],
        [width, fmt(x1)],
        [width >> 1, chart.xLabel === undefined ? '' : `${chart.xLabel} →`],
      ]),
      <ui.Text dimColor>{`n=${count}${fit}`}</ui.Text>,
    ]
  }

  const tall = 12
  const canvas = makeCanvas(width, tall)
  const all = chart.series.flatMap(series => series.values)
  const low = Math.min(...all)
  const high = Math.max(...all)
  const count = Math.max(...chart.series.map(series => series.values.length))
  const rowAt = (value: number): number => Math.round((1 - (value - low) / (high - low || 1)) * (tall - 1))
  const colOf = (index: number): number => Math.round((index / Math.max(1, count - 1)) * (width - 1))
  const upTo = Math.round((width - 1) * played)
  chart.series.forEach((series, at) => {
    const layer = makeCanvas(width, tall)
    trace(layer, rowsAcross(series.values, count, width, rowAt), upTo)
    stamp(canvas, layer, { color: tint(at) })
  })
  // The measured points sit on the lines; with few of them, so do their values.
  const isMarked = count <= 40
  chart.series.forEach((series, at) =>
    series.values.forEach((value, index) => {
      if (isMarked && colOf(index) <= upTo) put(canvas, colOf(index), rowAt(value), '●', { color: tint(at), bold: true })
    }),
  )
  if (played === 1 && count <= 8 && chart.series.length <= 3) {
    chart.series.forEach((series, at) =>
      series.values.forEach((value, index) => {
        const text = fmt(value)
        const size = widthOf(text)
        const col = colOf(index)
        const row = rowAt(value)
        const spots: [number, number][] = [
          [col - (size >> 1), row - 1],
          [col - (size >> 1), row + 1],
          [col + 2, row],
          [col - size - 1, row],
        ]
        const spot = spots.find(([x, y]) => isFree(canvas, x, y, size))
        if (spot) put(canvas, spot[0], spot[1], text, { color: tint(at) })
      }),
    )
  }
  const marks: [number, string][] =
    count <= 10
      ? Array.from({ length: count }, (_, index) => [colOf(index), labelAt(chart, index)])
      : [
          [0, labelAt(chart, 0)],
          [width, labelAt(chart, count - 1)],
          [width >> 1, labelAt(chart, (count - 1) >> 1)],
        ]

  return [
    ...axisRows(ui, rowsOf(canvas), `${fmt(high)}${chart.unit}`, `${fmt(low)}${chart.unit}`, `${fmt((low + high) / 2)}${chart.unit}`),
    ...floorOf(ui, width, marks),
    legendOf(ui, chart.series.map(series => series.name), chart.series.map((_, at) => tint(at))),
  ]
}

const drawHeat = (ui: UI, chart: Chart, room: number): any => {
  const count = Math.min(40, Math.max(...chart.series.map(series => series.values.length)))
  const labelW = clamp(Math.max(...chart.series.map(series => widthOf(series.name))), 3, 18)
  const cell = clamp(Math.floor((room - labelW - 1) / count), 2, 8)
  const all = chart.series.flatMap(series => series.values.slice(0, count))
  const low = Math.min(...all)
  const high = Math.max(...all)
  const head = makeCanvas(count * cell, 1)
  for (let index = 0; index < count; index++) put(head, index * cell, 0, clip(labelAt(chart, index), cell - 1), { dim: true })

  return [
    <ui.Box paddingLeft={labelW + 1}>{rowOf(ui, rowsOf(head)[0] ?? { indent: 0, segs: [] })}</ui.Box>,
    ...chart.series.map(series => (
      <ui.Box flexDirection="row">
        <ui.Box width={labelW + 1} flexShrink={0}>
          <ui.Text wrap="truncate-end">{series.name}</ui.Text>
        </ui.Box>
        <ui.Text color="claude">
          {Array.from({ length: count }, (_, index) => {
            const value = series.values[index]
            const level = value === undefined ? 0 : Math.round(((value - low) / (high - low || 1)) * 4)

            return (SHADES[level] ?? '·').repeat(cell - 1) + (index === count - 1 ? '' : ' ')
          }).join('')}
        </ui.Text>
      </ui.Box>
    )),
    <ui.Box flexDirection="row" columnGap={1}>
      <ui.Text dimColor>{`${fmt(low)}${chart.unit}`}</ui.Text>
      <ui.Text color="claude">{SHADES}</ui.Text>
      <ui.Text dimColor>{`${fmt(high)}${chart.unit}`}</ui.Text>
    </ui.Box>,
  ]
}

const drawFunnel = (ui: UI, chart: Chart, room: number, played: number): any => {
  const values = (chart.series[0]?.values ?? []).slice(0, 12)
  const labelW = clamp(Math.max(...values.map((_, index) => widthOf(labelAt(chart, index)))), 3, 22)
  const width = clamp(room - labelW - 26, 16, 64)
  const top = Math.max(1e-9, ...values)
  const first = values[0] || top

  return values.map((value, index) => {
    const cells = Math.max(1, Math.round((Math.max(0, value) / top) * width * played))
    return (
      <ui.Box flexDirection="row">
        <ui.Box width={labelW + 1} flexShrink={0}>
          <ui.Text wrap="truncate-end">{labelAt(chart, index)}</ui.Text>
        </ui.Box>
        <ui.Box width={width} flexShrink={0} paddingLeft={(width - cells) >> 1}>
          <ui.Text color={tint(index)}>{'█'.repeat(cells)}</ui.Text>
        </ui.Box>
        {aside(ui, `${fmt(value)}${chart.unit}`)}
        <ui.Box marginLeft={2} flexShrink={0}>
          <ui.Text bold>{`${trimNumber((value / first) * 100, 0)}%`}</ui.Text>
        </ui.Box>
      </ui.Box>
    )
  })
}

const drawShare = (ui: UI, chart: Chart, room: number, played: number): any => {
  const values = (chart.series[0]?.values ?? []).slice(0, 10).map(value => Math.max(0, value))
  const total = values.reduce((sum, value) => sum + value, 0) || 1
  const width = clamp(room - 2, 20, 90)
  const exact = values.map(value => (value / total) * width)
  const cells = exact.map(Math.floor)
  let spare = width - cells.reduce((sum, value) => sum + value, 0)
  exact
    .map((value, index) => ({ index, rest: value - Math.floor(value) }))
    .sort((a, b) => b.rest - a.rest)
    .forEach(one => {
      if (spare-- > 0) cells[one.index] = (cells[one.index] ?? 0) + 1
    })
  const shown = Math.round(width * played)
  let used = 0
  const widest = Math.max(...values.map((_, index) => widthOf(labelAt(chart, index))))

  return [
    <ui.Box flexDirection="row">
      {cells.map((size, index) => {
        const take = clamp(shown - used, 0, size)
        used += size

        return take > 0 && <ui.Text color={tint(index)}>{'█'.repeat(take)}</ui.Text>
      })}
    </ui.Box>,
    ...values.map((value, index) => (
      <ui.Box flexDirection="row" columnGap={1}>
        <ui.Text color={tint(index)}>■</ui.Text>
        <ui.Box width={clamp(widest, 3, 30) + 1} flexShrink={0}>
          <ui.Text wrap="truncate-end">{labelAt(chart, index)}</ui.Text>
        </ui.Box>
        <ui.Text bold>{`${trimNumber((value / total) * 100, 1)}%`}</ui.Text>
        <ui.Text dimColor>{`${fmt(value)}${chart.unit}`}</ui.Text>
      </ui.Box>
    )),
  ]
}

const drawChart = (ui: UI, chart: Chart, room: number, played: number): any => {
  if (chart.kind === 'bar' || chart.kind === 'stacked') return drawBars(ui, chart, room, played)
  if (chart.kind === 'column' || chart.kind === 'histogram') return drawColumns(ui, chart, room, played)
  if (chart.kind === 'line' || chart.kind === 'scatter') return drawPlot(ui, chart, room, played)
  if (chart.kind === 'heatmap') return drawHeat(ui, chart, room)
  if (chart.kind === 'funnel') return drawFunnel(ui, chart, room, played)

  return drawShare(ui, chart, room, played)
}

// ---------------------------------------------------------------- cards

type Info = { title: string; subtitle?: string; tags: string[]; lines: string[]; quote?: string; tone: string }
type Cards = { title: string; cards: Info[] }

const readCards = (input: unknown): Cards | string => {
  const raw = record(input)
  const cards: Info[] = []
  for (const one of items(raw.cards).slice(0, 9)) {
    const card = record(one)
    const title = words(card.title ?? card.name, 50)
    if (title === undefined) continue
    cards.push({
      title,
      subtitle: words(card.subtitle, 70),
      tags: wordList(card.tags, 5, 18),
      lines: wordList(card.lines, 6, 90),
      quote: words(card.quote, 160),
      tone: pick(card.tone, ['good', 'bad', 'warn', 'plain'] as const, 'plain'),
    })
  }
  if (cards.length === 0) return 'cards is empty: each needs a title'

  return { title: words(raw.title, 80) ?? 'Cards', cards }
}

const drawCards = (ui: UI, cards: Cards, room: number): any => {
  const width = clamp(Math.floor(room / Math.min(cards.cards.length, 3)) - 1, 24, 46)

  return (
    <ui.Box flexDirection="row" flexWrap="wrap" columnGap={1}>
      {cards.cards.map((card, index) => {
        const color = card.tone === 'plain' ? tint(index) : (TONES[card.tone] ?? 'text')

        return (
          <ui.Box borderStyle="round" borderColor={color} flexDirection="column" paddingX={1} width={width}>
            <ui.Text bold color={color} wrap="truncate-end">
              {card.title}
            </ui.Text>
            {card.subtitle !== undefined && (
              <ui.Text dimColor wrap="wrap">
                {card.subtitle}
              </ui.Text>
            )}
            {card.tags.length > 0 && (
              <ui.Text color="suggestion" wrap="truncate-end">
                {card.tags.map(tag => `#${tag}`).join(' ')}
              </ui.Text>
            )}
            {card.lines.map(line => (
              <ui.Box flexDirection="row" columnGap={1}>
                <ui.Text color={color}>•</ui.Text>
                <ui.Text wrap="wrap">{line}</ui.Text>
              </ui.Box>
            ))}
            {card.quote !== undefined && (
              <ui.Text italic dimColor wrap="wrap">
                {`“${card.quote}”`}
              </ui.Text>
            )}
          </ui.Box>
        )
      })}
    </ui.Box>
  )
}

// ---------------------------------------------------------------- compare

type Option = { name: string; summary?: string; pros: string[]; cons: string[]; effort?: string; isRecommended: boolean }
type Comparison = { title: string; options: Option[]; verdict?: string; isAsking: boolean }

const readComparison = (input: unknown): Comparison | string => {
  const raw = record(input)
  const options: Option[] = []
  for (const one of items(raw.options).slice(0, 4)) {
    const option = record(one)
    const name = words(option.name, 40)
    if (name === undefined) continue
    options.push({
      name,
      summary: words(option.summary, 120),
      pros: wordList(option.pros, 4, 80),
      cons: wordList(option.cons, 4, 80),
      effort: words(option.effort, 40),
      isRecommended: option.isRecommended === true,
    })
  }
  if (options.length < 2) return 'options needs at least two entries, each with a name'

  return {
    title: words(raw.question, 100) ?? 'Options',
    options,
    verdict: words(raw.verdict, 200),
    isAsking: raw.isAsking !== false,
  }
}

const drawComparison = (ui: UI, comparison: Comparison, room: number): any => {
  const width = clamp(Math.floor(room / comparison.options.length) - 1, 24, 44)
  const point = (mark: string, color: string, text: string): any => (
    <ui.Box flexDirection="row" columnGap={1}>
      <ui.Text color={color}>{mark}</ui.Text>
      <ui.Text color={color} wrap="wrap">
        {text}
      </ui.Text>
    </ui.Box>
  )

  return [
    <ui.Box flexDirection="row" flexWrap="wrap" columnGap={1}>
      {comparison.options.map(option => (
        <ui.Box
          borderStyle={option.isRecommended ? 'bold' : 'round'}
          borderColor={option.isRecommended ? 'success' : 'inactive'}
          flexDirection="column"
          paddingX={1}
          width={width}
        >
          <ui.Text bold color={option.isRecommended ? 'success' : 'text'} wrap="truncate-end">
            {option.isRecommended ? `★ ${option.name}` : option.name}
          </ui.Text>
          {option.summary !== undefined && (
            <ui.Text dimColor wrap="wrap">
              {option.summary}
            </ui.Text>
          )}
          {option.pros.map(text => point('+', 'success', text))}
          {option.cons.map(text => point('−', 'error', text))}
          {option.effort !== undefined && (
            <ui.Text dimColor wrap="truncate-end">
              {`≈ ${option.effort}`}
            </ui.Text>
          )}
        </ui.Box>
      ))}
    </ui.Box>,
    comparison.verdict !== undefined && (
      <ui.Box flexDirection="row" columnGap={1}>
        <ui.Text bold color="success">
          →
        </ui.Text>
        <ui.Text wrap="wrap">{comparison.verdict}</ui.Text>
      </ui.Box>
    ),
  ]
}

// ---------------------------------------------------------------- the tools

const text = (description?: string): Record<string, unknown> =>
  description === undefined ? { type: 'string' } : { type: 'string', description }
const list = (of: Record<string, unknown>, description?: string): Record<string, unknown> =>
  description === undefined ? { type: 'array', items: of } : { type: 'array', items: of, description }
const shape = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: 'object',
  properties,
  required,
})
const TONE = { type: 'string', enum: ['good', 'bad', 'warn', 'plain'] }
const SEEN = 'The person sees the card, not this result: do not repeat it in text. Keep every label short.'

type Kind = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  // Reads the input: a string is the reason it cannot be drawn.
  read: (input: unknown) => any
  draw: (ui: UI, model: any, room: number, played: number) => any
  summary: (model: any) => string
  isAnimated?: boolean
}

const KINDS: Kind[] = [
  {
    name: 'diagram',
    description: `Draws nodes and arrows as a diagram laid out top to bottom: system architecture, data or user flows, dependencies, processes, org charts. Call it in place of describing structure in paragraphs. Edges may branch, merge, skip layers and loop back; the wires leaving a node travel together in its color. A node's group gives it a color and its shape says what it is. An edge from a node to itself is drawn as a loop inside it, so state machines work: states as round nodes, transitions as labelled edges. Up to 28 nodes; a layer wider than about 6 nodes gets cramped, so prefer depth. ${SEEN}`,
    inputSchema: shape(
      {
        title: text(),
        nodes: list(
          shape({ id: text('short key the edges use'), label: text(), note: text('one short phrase'), group: text('color group: Client, API, Data'), shape: { type: 'string', enum: [...SHAPES], description: 'box (default), round (a start, an end, a state), decision (a branch point), store (a database or queue), external (outside the system), person (a user or role)' } }, ['id', 'label']),
        ),
        edges: list(shape({ from: text('node id'), to: text('node id'), label: text('what travels, one or two words') }, ['from', 'to'])),
        notes: list(text(), 'key decisions or risks, 4 at most'),
        layout: { type: 'string', enum: ['flow', 'zones', 'matrix'], description: 'flow (default): boxes and wires. zones: each group is a framed band, stacked in the order the groups first appear, for boundaries such as a VPC, a subsystem or a C4 container view. matrix: a grid of who depends on whom, for dependencies too dense for wires' },
      },
      ['title', 'nodes', 'edges'],
    ),
    read: readGraph,
    draw: (ui, graph, room) => drawDiagram(ui, graph, room),
    summary: (graph: Graph) =>
      `diagram "${graph.title}", ${graph.nodes.length} nodes, ${graph.edges.length} edges${graph.dropped > 0 ? `; ${graph.dropped} edges left out (unknown node id, a duplicate, or a node to itself)` : ''}`,
  },
  {
    name: 'layers',
    description: `Draws the block picture of an architecture: bands stacked top to bottom (Clients, Gateway, Services, Data, Infrastructure), each holding components as blocks, optionally gathered into named zones that may hold zones of their own (region, availability zone, subnet: a deployment topology), with cross-cutting concerns (security, monitoring, CI/CD) standing beside every band. Use it for a tech stack, a platform or capability map, a layered system overview: what exists and where it sits. For how things connect, use diagram. Up to 8 layers. ${SEEN}`,
    inputSchema: shape(
      {
        title: text(),
        layers: list(
          shape({ name: text(), items: list(text(), 'components directly in this layer'), zones: list(shape({ name: text(), items: list(text()), zones: list({ type: 'object' }, 'zones inside this one, same shape, up to 3 deep') }, ['name']), 'named groups inside the layer, 5 at most') }, ['name']),
          'top (what people touch) to bottom (infrastructure)',
        ),
        sides: list(shape({ name: text(), items: list(text()) }, ['name']), 'concerns that cut across all layers, 3 at most'),
        notes: list(text(), 'decisions or risks, 4 at most'),
      },
      ['title', 'layers'],
    ),
    read: readLayers,
    draw: (ui, layers, room) => drawLayers(ui, layers, room),
    summary: (layers: Layers) => `layers "${layers.title}", ${layers.bands.length} layers`,
  },
  {
    name: 'schema',
    description: `Draws a data model or a class diagram: each entity is a box with its fields listed under its name, and relations are wires between boxes. For database tables and their keys (an ER diagram), domain models, classes or components with their members. Mark a field's key as pk or fk; put the cardinality (1:1, 1:N, N:N) or the kind of link (extends, uses) on the relation. Up to 14 entities of 14 fields. ${SEEN}`,
    inputSchema: shape(
      {
        title: text(),
        entities: list(
          shape({ name: text(), note: text(), group: text('color group'), fields: list(shape({ name: text(), type: text(), key: { type: 'string', enum: ['pk', 'fk'] } }, ['name']), 'fields of a table, or members of a class') }, ['name', 'fields']),
        ),
        relations: list(shape({ from: text('entity name'), to: text('entity name'), kind: text('1:1, 1:N, N:N, extends, uses'), label: text() }, ['from', 'to'])),
        notes: list(text()),
      },
      ['title', 'entities'],
    ),
    read: readSchema,
    draw: (ui, graph, room) => drawDiagram(ui, graph, room),
    summary: (graph: Graph) => `schema "${graph.title}", ${graph.nodes.length} entities, ${graph.edges.length} relations`,
  },
  {
    name: 'swimlane',
    description: `Draws a process as swimlanes: one lane per role, team or system, the steps left to right in the order they happen, each in the lane of whoever does it, so every handover shows. Up to 6 lanes and 10 steps. A step flows to the next one unless next names other steps. ${SEEN}`,
    inputSchema: shape(
      {
        title: text(),
        lanes: list(text(), 'top to bottom'),
        steps: list(shape({ id: text(), label: text('two or three words'), lane: text('one of lanes'), next: list(text(), 'ids of later steps it leads to, when not simply the next one') }, ['label', 'lane']), 'in time order'),
      },
      ['title', 'lanes', 'steps'],
    ),
    read: readSwimlane,
    draw: (ui, swim, room) => drawSwimlane(ui, swim, room),
    summary: (swim: Swimlane) => `swimlane "${swim.title}", ${swim.lanes.length} lanes, ${swim.steps.length} steps`,
  },
  {
    name: 'pipeline',
    description: `Draws stages left to right, each a column of jobs, every stage feeding the next: CI/CD pipelines, ETL and data flows, build or release steps, any process that reads as "then". A job may carry a status. Up to 7 stages of 6 jobs. ${SEEN}`,
    inputSchema: shape(
      {
        title: text(),
        stages: list(shape({ name: text(), jobs: list(shape({ label: text(), status: { type: 'string', enum: ['done', 'doing', 'todo', 'risk'] } }, ['label'])) }, ['name', 'jobs'])),
        labels: shape({ done: text(), doing: text(), todo: text(), risk: text() }),
      },
      ['title', 'stages'],
    ),
    read: readPipeline,
    draw: (ui, pipeline, room) => drawPipeline(ui, pipeline, room),
    summary: (pipeline: Pipeline) => `pipeline "${pipeline.title}", ${pipeline.stages.length} stages`,
  },
  {
    name: 'gitgraph',
    description: `Draws branches as lanes over time: commits, where a branch forks, where it merges back, and tags. For a branching strategy, a release flow, the history of a feature. branches go top to bottom, the first being the trunk; events are in time order. Up to 6 branches and 24 events. ${SEEN}`,
    inputSchema: shape(
      {
        title: text(),
        branches: list(shape({ name: text(), from: text('the branch it forks from; the trunk when left out') }, ['name'])),
        events: list(shape({ branch: text(), label: text('a few words'), merge: text('a branch merged into this one at this commit'), tag: text('v1.2') }, ['branch']), 'in time order'),
      },
      ['title', 'branches', 'events'],
    ),
    read: readGitGraph,
    draw: (ui, git, room) => drawGitGraph(ui, git, room),
    summary: (git: GitGraph) => `gitgraph "${git.title}", ${git.branches.length} branches, ${git.events.length} events`,
  },
  {
    name: 'sequence',
    description: `Draws a sequence diagram: actors across the top, messages between them in order. For request flows, protocols, handoffs between people or teams. Up to 7 actors and 24 messages. ${SEEN}`,
    inputSchema: shape(
      {
        title: text(),
        actors: list(text(), 'left to right'),
        messages: list(shape({ from: text(), to: text(), label: text(), isReply: { type: 'boolean', description: 'a dashed return arrow' } }, ['from', 'to', 'label'])),
      },
      ['title', 'actors', 'messages'],
    ),
    read: readSequence,
    draw: (ui, sequence, room) => drawSequence(ui, sequence, room),
    summary: (sequence: Sequence) => `sequence "${sequence.title}", ${sequence.actors.length} actors, ${sequence.messages.length} messages`,
  },
  {
    name: 'tree',
    description: `Draws a hierarchy as a tree: sitemaps, goal breakdowns (OKRs), mind maps, file layouts, taxonomies, topic outlines. Up to 90 nodes. ${SEEN}`,
    inputSchema: shape(
      {
        title: text(),
        layout: { type: 'string', enum: ['list', 'mindmap'], description: 'list (default): an indented outline. mindmap: branches spreading to the right' },
        root: shape({ label: text(), note: text(), children: list({ type: 'object' }, 'nodes of the same shape: { label, note, children }') }, ['label']),
      },
      ['title', 'root'],
    ),
    read: readTree,
    draw: (ui, tree, room) => drawTree(ui, tree, room),
    summary: (tree: Tree) => `tree "${tree.title}", ${tree.count} nodes`,
  },
  {
    name: 'timeline',
    description: `Draws bars over periods: roadmaps, gantt schedules, project phases, study plans. periods are the column labels in order; each item spans from one period to another. ${SEEN}`,
    inputSchema: shape(
      {
        title: text(),
        periods: list(text(), 'in order: Q1, Q2 or W1, W2 or Jan, Feb; 18 at most'),
        items: list(
          shape({ name: text(), from: text('a period label'), to: text('a period label'), status: { type: 'string', enum: ['done', 'doing', 'todo', 'risk'] }, group: text('a heading above consecutive items') }, ['name', 'from', 'to']),
        ),
        milestones: list(shape({ name: text(), at: text('a period label') }, ['name', 'at'])),
        labels: shape({ done: text(), doing: text(), todo: text(), risk: text() }),
      },
      ['title', 'periods', 'items'],
    ),
    read: readTimeline,
    draw: drawTimeline,
    summary: (timeline: Timeline) => `timeline "${timeline.title}", ${timeline.tasks.length} items over ${timeline.periods.length} periods`,
    isAnimated: true,
  },
  {
    name: 'board',
    description: `Draws columns of cards: kanban, backlog by status, now/next/later, ideas by theme. Up to 6 columns of 8 cards. ${SEEN}`,
    inputSchema: shape(
      {
        title: text(),
        columns: list(shape({ name: text(), cards: list(shape({ title: text(), meta: text('owner, size or tag') }, ['title'])) }, ['name', 'cards'])),
      },
      ['title', 'columns'],
    ),
    read: readBoard,
    draw: (ui, board, room) => drawBoard(ui, board, room),
    summary: (board: Board) => `board "${board.title}", ${board.columns.length} columns`,
  },
  {
    name: 'quadrant',
    description: `Draws a 2x2. With items it plots each on two axes (impact vs effort, value vs risk, positioning maps). With areas that hold points and no items it draws four lists (SWOT, do/delegate/defer/drop). areas go top-left, top-right, bottom-left, bottom-right. ${SEEN}`,
    inputSchema: shape(
      {
        title: text(),
        xLow: text('the left end of the x axis'),
        xHigh: text(),
        yLow: text('the bottom end of the y axis'),
        yHigh: text(),
        areas: list(shape({ name: text(), points: list(text()) }), 'four, in order TL, TR, BL, BR'),
        items: list(shape({ name: text(), x: { type: 'number', description: '0 (left) to 1 (right)' }, y: { type: 'number', description: '0 (bottom) to 1 (top)' } }, ['name', 'x', 'y'])),
      },
      ['title'],
    ),
    read: readQuadrant,
    draw: (ui, quadrant, room) => drawQuadrant(ui, quadrant, room),
    summary: (quadrant: Quadrant) => `quadrant "${quadrant.title}", ${quadrant.points.length > 0 ? `${quadrant.points.length} items plotted` : 'four lists'}`,
  },
  {
    name: 'journey',
    description: `Draws a journey map: stages left to right with a mood curve, and rows of notes under each stage (what they do, pain points, opportunities). For user journeys, service blueprints, onboarding, research synthesis. Up to 7 stages and 5 rows. ${SEEN}`,
    inputSchema: shape(
      {
        title: text(),
        who: text('the persona or scenario, one line'),
        moodLabel: text('the word for the mood row'),
        stages: list(shape({ name: text(), mood: { type: 'number', description: '1 (worst) to 5 (best)' } }, ['name', 'mood'])),
        rows: list(shape({ name: text('row label: Actions, Pain, Ideas'), tone: TONE, cells: list(text(), 'one short cell per stage, in order') }, ['name', 'cells'])),
      },
      ['title', 'stages'],
    ),
    read: readJourney,
    draw: drawJourney,
    summary: (journey: Journey) => `journey "${journey.title}", ${journey.stages.length} stages, ${journey.rows.length} rows`,
    isAnimated: true,
  },
  {
    name: 'wireframe',
    description: `Draws a low-fidelity wireframe of a screen from nested rows and columns of boxes. For page layouts, app screens, dashboards, before any real design. A container is { type: "row" | "column", children, size }; a leaf is { kind, label, size, lines } with kind one of heading, text, image, button, input, nav, list, label. size is a share of the row's width. Up to 48 boxes. ${SEEN}`,
    inputSchema: shape(
      {
        title: text(),
        device: { type: 'string', enum: ['desktop', 'mobile'] },
        screen: shape({ type: { type: 'string', enum: ['row', 'column'] }, children: list({ type: 'object' }, 'containers and leaves, nested') }, ['children']),
      },
      ['title', 'screen'],
    ),
    read: readWireframe,
    draw: (ui, wireframe, room) => drawWireframe(ui, wireframe, room),
    summary: (wireframe: Wireframe) => `wireframe "${wireframe.title}", ${wireframe.count} boxes`,
  },
  {
    name: 'metrics',
    description: `Draws number tiles: a label, a big value, the change, and a small trend line from series. For KPIs, experiment results, a status snapshot. Up to 8 tiles. ${SEEN}`,
    inputSchema: shape(
      {
        title: text(),
        tiles: list(
          shape({ label: text(), value: text('as shown: 12.4k, 38%, $1.2M'), delta: text('as shown: ▲ 12% vs last week'), tone: TONE, series: list({ type: 'number' }, 'recent values, oldest first'), note: text() }, ['label', 'value']),
        ),
      },
      ['title', 'tiles'],
    ),
    read: readMetrics,
    draw: drawMetrics,
    summary: (metrics: Metrics) => `metrics "${metrics.title}", ${metrics.tiles.length} tiles`,
    isAnimated: true,
  },
  {
    name: 'chart',
    description: `Draws one chart from numbers you already have. kind: bar (categories, horizontal), column (categories, vertical), stacked (parts per category), line (series over an ordered x), scatter (points: x against y), heatmap (series are rows, labels are columns), histogram (one series of raw values, binned), funnel (steps that shrink), share (parts of one whole). labels name the categories or x positions; series hold the numbers in the same order. Never invent numbers to fill a chart. ${SEEN}`,
    inputSchema: shape(
      {
        kind: { type: 'string', enum: [...CHART_KINDS] },
        title: text(),
        unit: text('ms, %, $: appended to values'),
        labels: list(text()),
        series: list(shape({ name: text(), values: list({ type: 'number' }) }, ['values'])),
        points: list(shape({ x: { type: 'number' }, y: { type: 'number' } }, ['x', 'y']), 'scatter only'),
        xLabel: text('scatter only'),
        yLabel: text('scatter only'),
        bins: { type: 'number', description: 'histogram only' },
      },
      ['kind', 'title'],
    ),
    read: readChart,
    draw: drawChart,
    summary: (chart: Chart) => `${chart.kind} chart "${chart.title}"`,
    isAnimated: true,
  },
  {
    name: 'cards',
    description: `Draws titled cards side by side: personas, research findings with a quote, feature summaries, principles, risks. Up to 9 cards. ${SEEN}`,
    inputSchema: shape(
      {
        title: text(),
        cards: list(shape({ title: text(), subtitle: text(), tags: list(text()), lines: list(text(), 'short bullet points, 6 at most'), quote: text('a verbatim quote'), tone: TONE }, ['title'])),
      },
      ['title', 'cards'],
    ),
    read: readCards,
    draw: (ui, cards, room) => drawCards(ui, cards, room),
    summary: (cards: Cards) => `${cards.cards.length} cards "${cards.title}"`,
  },
  {
    name: 'compare',
    description: `Draws two to four options as side-by-side cards with pros, cons and the recommended one marked, then has the person pick one in a dialog under the cards; the result says which they picked. Call it when the person has to weigh a choice, and do not ask the same question again in text or with another question tool. ${SEEN}`,
    inputSchema: shape(
      {
        question: text('the decision, as a short question'),
        options: list(
          shape({ name: text(), summary: text('one line: what choosing it means'), pros: list(text()), cons: list(text()), effort: text('cost or effort in a few words'), isRecommended: { type: 'boolean' } }, ['name']),
          '2 to 4',
        ),
        verdict: text('one line: which and why'),
        isAsking: { type: 'boolean', description: 'false: only draw, no dialog, for a comparison that needs no decision now' },
      },
      ['question', 'options'],
    ),
    read: readComparison,
    draw: (ui, comparison, room) => drawComparison(ui, comparison, room),
    summary: (comparison: Comparison) => `${comparison.options.length} options`,
  },
]

const KIND_OF = new Map(KINDS.map(kind => [toolOf(kind.name), kind]))
const COMPARE = toolOf('compare')

const GUIDE = [
  '# Visual answers (sketch mod)',
  'The person reads in a terminal and finds long paragraphs hard to follow. Whenever the content has a shape, draw the shape with a sketch tool and keep the text around it to a line or two. This holds for any field: engineering, product, design, research, planning.',
  `- What a system is made of (layers of components, zones, cross-cutting concerns): ${toolOf('layers')}. How things connect (architecture wiring, a flow or process with decisions, dependencies, a pipeline): ${toolOf('diagram')}, with layout "zones" to frame subsystems or boundaries and "matrix" when dependencies are dense; a state machine is a diagram too. Tables and their relations, or classes and their members: ${toolOf('schema')}. A process across roles or systems: ${toolOf('swimlane')}. Stages left to right (CI/CD, ETL, a data flow): ${toolOf('pipeline')}. Branches, merges and releases: ${toolOf('gitgraph')}. Who calls whom in order: ${toolOf('sequence')}. A hierarchy, breakdown or mind map: ${toolOf('tree')}.`,
  `- A plan over time, a roadmap or schedule: ${toolOf('timeline')}. Work by status or theme: ${toolOf('board')}.`,
  `- Prioritising on two axes, positioning, SWOT: ${toolOf('quadrant')}. A user journey or service blueprint: ${toolOf('journey')}. A screen or page layout: ${toolOf('wireframe')}.`,
  `- Numbers: ${toolOf('chart')} (bar, column, stacked, line, scatter, heatmap, histogram, funnel, share); a handful of headline numbers: ${toolOf('metrics')}.`,
  `- Personas, findings, principles, feature summaries: ${toolOf('cards')}. A choice between two to four options: ${COMPARE}, which also asks the person to pick; act on what its result says and do not ask again in text.`,
  '- A plain list of facts or a small comparison with no better shape: a markdown table.',
  'The sketch tools are deferred: load a tool with ToolSearch (select:<name>) before its first call.',
  'The person sees the card, not the tool result, so never repeat a card in text. Keep labels short: a card is for scanning, and detail belongs in a follow-up when asked. Draw only what is true: no invented numbers, nodes or quotes to fill a card.',
].join('\n')

// How far each running card's entrance has played, 0 to 1, by tool_use_id.
const entrances = new Map<string, number>()
const STEPS = 7

const roomOf = (columns: number | undefined): number => Math.max(40, Math.min(columns ?? 100, 150) - 6)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    for (const kind of KINDS) {
      await $.tool.register({
        name: kind.name,
        description: kind.description,
        inputSchema: kind.inputSchema,
        isDeferred: true,
      })
    }

    return next(e)
  })

  for (const kind of KINDS) {
    const tool = toolOf(kind.name)
    on('tool.call', { tool }, async ($: any, e: any, next: any) => {
      const model = kind.read(e)
      if (typeof model === 'string') return { deny: model }
      const drawn = `Drawn for the person: ${kind.summary(model)}.`

      if (kind.isAnimated === true && (next?.budget?.remainingMs ?? 0) > 4000) {
        const id = String(e.tool_use_id)
        try {
          for (let frame = 1; frame <= STEPS; frame++) {
            const at = frame / (STEPS + 1)
            entrances.set(id, 1 - (1 - at) * (1 - at))
            $.ui.invalidate('ui.render')
            await $.clock.sleep(80)
          }
        } catch {
          // An entrance that cannot play is skipped: the card draws whole.
        }
        entrances.delete(id)
        $.ui.invalidate('ui.render')
      }

      if (tool !== COMPARE || !model.isAsking) return { result: `${drawn} Do not repeat it in text.` }

      // Cards in a transcript cannot be pressed, so the pick is made in the
      // engine's own dialog under them: arrow keys and Enter, recommended first.
      const comparison = model as Comparison
      const labelOf = (option: Option): string => (option.isRecommended ? `${option.name} ★` : option.name)
      const ordered = [
        ...comparison.options.filter(option => option.isRecommended),
        ...comparison.options.filter(option => !option.isRecommended),
      ]
      let answer: string | undefined
      try {
        answer = await $.ui.ask(comparison.title, { options: ordered.map(labelOf) })
      } catch {
        answer = undefined
      }
      if (answer === undefined) {
        return {
          result: `${drawn} The person closed the dialog without picking. Do not repeat the cards; ask in one line what they want, and change nothing until they say.`,
        }
      }
      const chosen = ordered.find(option => labelOf(option) === answer)

      return {
        result: chosen
          ? `${drawn} The person picked "${chosen.name}" in the dialog. Act on that choice; do not repeat the cards.`
          : `${drawn} The person picked none of them and answered in their own words: "${answer.slice(0, 500)}". Follow that; do not repeat the cards.`,
      }
    }).catch(() => ({ deny: `sketch could not draw this ${kind.name}: check the input against the tool's schema` }))
  }

  // The first version's tool, kept answering so a call made from habit says where to go.
  on('tool.call', { tool: toolOf('architecture') }, async () => ({
    deny: `architecture is now ${toolOf('diagram')}: nodes [{ id, label, note, group }] and edges [{ from, to, label }]`,
  })).catch(() => ({ deny: `use ${toolOf('diagram')}` }))

  on('prompt.compose', async (_$, e, next) => {
    const composed = await next(e)

    return {
      sections: [
        ...composed.sections.filter(section => section.id !== 'sketch:visual-answers'),
        { id: 'sketch:visual-answers', text: GUIDE, scope: 'session' },
      ],
    }
  })

  on('ui.render', { component: 'ToolUse' }, async ($: any, e: any, next: any) => {
    const kind = KIND_OF.get(e.props.tool)
    if (!kind) return next(e)
    // ctrl+o and --verbose show the call as the engine draws it.
    if (e.props.isExpanded === true || e.props.isErrored === true) return next(e)
    const model = kind.read(e.props.input)
    if (typeof model === 'string') return next(e)

    const ui: UI = $.ui.resolve(e)
    const played =
      kind.isAnimated === true && e.props.isRunning === true
        ? (entrances.get(String(e.props.tool_use_id)) ?? 0.04)
        : 1

    return frameOf(ui, model.title, kind.draw(ui, model, roomOf(e.viewport?.columns), played))
  })

  // The result is written for the model; under a drawn card it is noise.
  on('ui.render', { component: 'ToolResult' }, async ($: any, e: any, next: any) => {
    if (!KIND_OF.has(e.props.tool) || e.props.isErrored === true || e.props.isExpanded === true) return next(e)
    const ui: UI = $.ui.resolve(e)

    return <ui.Box />
  })
}
