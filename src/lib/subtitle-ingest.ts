import { makeQuerySlug } from "@/lib/wiki-filename"

export const SUBTITLE_SOURCE_EXTENSIONS = new Set(["srt", "lrc", "vtt"])

export type SubtitleFormat = "srt" | "lrc" | "vtt" | "text"

export interface SubtitleLine {
  start: number
  end?: number
  text: string
  rawTime: string
}

export interface SubtitleKnowledgePoint {
  id?: string
  concept_name?: string
  concept_type?: string
  time_range?: unknown
  importance_level?: string
  core_definition?: string
  detailed_content?: string
  exam_relevance?: string
  relationships?: unknown
  [key: string]: unknown
}

export interface SubtitleAnalysis {
  course_overview?: unknown
  knowledge_points: SubtitleKnowledgePoint[]
  concept_structure?: unknown
  teaching_insights?: unknown
  [key: string]: unknown
}

export interface SubtitleSegment {
  knowledgePoint: SubtitleKnowledgePoint
  suggestedPath: string
  timeRange: string
  content: string
}

export interface SubtitleAnalysisChunk {
  index: number
  total: number
  lineCount: number
  startTime?: string
  endTime?: string
  content: string
}

interface TimeRange {
  start: number
  end: number
}

const DEFAULT_SEGMENT_BUFFER_SECONDS = 30
const DEFAULT_ANALYSIS_SOURCE_CHARS = 140_000
const DEFAULT_CONTEXT_CHARS = 180_000

export function isSubtitleSourcePath(path: string): boolean {
  const name = path.replace(/\\/g, "/").split("/").pop() ?? ""
  const ext = name.includes(".") ? name.split(".").pop()?.toLowerCase() : ""
  return !!ext && SUBTITLE_SOURCE_EXTENSIONS.has(ext)
}

export function detectSubtitleFormat(content: string, path = ""): SubtitleFormat {
  const ext = path.split(".").pop()?.toLowerCase()
  if (ext === "srt" || ext === "lrc" || ext === "vtt") return ext
  const sample = content.slice(0, 4000)
  if (/^\s*WEBVTT\b/i.test(sample)) return "vtt"
  if (/\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]/.test(sample)) return "lrc"
  if (/\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}/.test(sample)) return "srt"
  return "text"
}

export function parseTimeToSeconds(value: string): number | null {
  const normalized = value.trim().replace(",", ".")
  if (!normalized) return null
  const parts = normalized.split(":")
  if (parts.length < 2 || parts.length > 3) return null

  const numeric = parts.map((part) => Number.parseFloat(part))
  if (numeric.some((part) => Number.isNaN(part))) return null

  if (parts.length === 2) {
    const [minutes, seconds] = numeric
    return minutes * 60 + seconds
  }

  const [hours, minutes, seconds] = numeric
  return hours * 3600 + minutes * 60 + seconds
}

export function formatTimestamp(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(safe / 3600)
  const minutes = Math.floor((safe % 3600) / 60)
  const secs = safe % 60
  const mm = String(minutes).padStart(2, "0")
  const ss = String(secs).padStart(2, "0")
  if (hours > 0) return `${String(hours).padStart(2, "0")}:${mm}:${ss}`
  return `${mm}:${ss}`
}

export function createTimestampLink(timestamp: string, courseUrl?: string): string {
  const seconds = parseTimeToSeconds(timestamp)
  if (!courseUrl || seconds === null) return timestamp
  const wholeSeconds = Math.max(0, Math.floor(seconds))
  if (/youtu\.be|youtube\.com/i.test(courseUrl)) {
    const separator = courseUrl.includes("?") ? "&" : "?"
    return `[${timestamp}](${courseUrl}${separator}t=${wholeSeconds}s)`
  }
  if (/bilibili\.com/i.test(courseUrl)) {
    const separator = courseUrl.includes("?") ? "&" : "?"
    return `[${timestamp}](${courseUrl}${separator}t=${wholeSeconds})`
  }
  try {
    const url = new URL(courseUrl)
    url.searchParams.set("t", String(wholeSeconds))
    return `[${timestamp}](${url.toString()})`
  } catch {
    const separator = courseUrl.includes("?") ? "&" : "?"
    return `[${timestamp}](${courseUrl}${separator}t=${wholeSeconds})`
  }
}

export function parseSubtitleContent(content: string, path = ""): SubtitleLine[] {
  const format = detectSubtitleFormat(content, path)
  if (format === "srt") return parseSrtContent(content)
  if (format === "lrc") return parseLrcContent(content)
  if (format === "vtt") return parseVttContent(content)
  return []
}

export function parseSubtitleAnalysisResponse(raw: string): SubtitleAnalysis {
  const objectText = extractJsonObject(raw)
  if (!objectText) return { knowledge_points: [] }
  try {
    const parsed = JSON.parse(objectText) as Record<string, unknown>
    const knowledgePoints = Array.isArray(parsed.knowledge_points)
      ? parsed.knowledge_points.filter(isRecord).map((kp) => kp as SubtitleKnowledgePoint)
      : []
    return {
      ...parsed,
      knowledge_points: knowledgePoints,
    }
  } catch {
    return { knowledge_points: [] }
  }
}

export function buildSubtitleAnalysisChunks(args: {
  sourceContent: string
  sourceIdentity: string
  maxChars: number
}): SubtitleAnalysisChunk[] {
  const maxChars = Math.max(1, args.maxChars)
  const lines = parseSubtitleContent(args.sourceContent, args.sourceIdentity)
  if (lines.length === 0) {
    return chunkPlainText(args.sourceContent.trim(), maxChars)
  }

  const chunks: SubtitleLine[][] = []
  let current: SubtitleLine[] = []
  let currentLength = 0

  for (const line of lines) {
    const rendered = formatSubtitleLine(line)
    const nextLength = currentLength + rendered.length + (current.length > 0 ? 1 : 0)
    if (current.length > 0 && nextLength > maxChars) {
      chunks.push(current)
      current = []
      currentLength = 0
    }
    current.push(line)
    currentLength += rendered.length + (current.length > 1 ? 1 : 0)
  }
  if (current.length > 0) chunks.push(current)

  const total = chunks.length
  return chunks.map((chunk, idx) => ({
    index: idx + 1,
    total,
    lineCount: chunk.length,
    startTime: formatTimestamp(chunk[0].start),
    endTime: formatTimestamp(chunk[chunk.length - 1].end ?? chunk[chunk.length - 1].start),
    content: formatSubtitleLines(chunk),
  }))
}

export function buildSubtitleAnalysisConsolidationPrompt(args: {
  purpose: string
  index: string
  sourceIdentity: string
  folderContext?: string
}): { system: string; userPrefix: string } {
  return {
    system: [
      "You are consolidating partial JSON analyses of a Chinese legal-exam subtitle course.",
      "Do not output chain-of-thought, markdown prose, comments, or code fences. Return valid JSON only.",
      "",
      "Merge the chunk analyses into one complete course-level knowledge map.",
      "Rules:",
      "- Keep all independent legal knowledge points from every chunk.",
      "- Deduplicate only when two entries clearly describe the same legal concept and overlapping time range.",
      "- Preserve absolute timestamp ranges from the original transcript.",
      "- Renumber final knowledge point ids as KP001, KP002, ... in learning order.",
      "- Preserve teacher emphasis, examples, common traps, exam strategy, and concept relationships.",
      "",
      "Return the same JSON shape used by the chunk analyses:",
      "{",
      '  "course_overview": {...},',
      '  "knowledge_points": [...],',
      '  "concept_structure": {...},',
      '  "teaching_insights": {...}',
      "}",
      "",
      args.purpose ? `## Wiki Purpose\n${args.purpose}` : "",
      args.index ? `## Current Wiki Index\n${args.index}` : "",
    ].filter(Boolean).join("\n"),
    userPrefix: [
      `Consolidate subtitle analyses for: ${args.sourceIdentity}`,
      args.folderContext ? `Folder context: ${args.folderContext}` : "",
      "",
      "The following chunk analyses cover the source in order.",
    ].filter(Boolean).join("\n"),
  }
}

export function mergeSubtitleAnalyses(analyses: SubtitleAnalysis[]): SubtitleAnalysis {
  const knowledgePoints = analyses.flatMap((analysis) => analysis.knowledge_points)
  return {
    course_overview: firstPresent(analyses.map((analysis) => analysis.course_overview)),
    knowledge_points: knowledgePoints.map((kp, idx) => ({
      ...kp,
      id: `KP${String(idx + 1).padStart(3, "0")}`,
    })),
    concept_structure: firstPresent(analyses.map((analysis) => analysis.concept_structure)),
    teaching_insights: firstPresent(analyses.map((analysis) => analysis.teaching_insights)),
  }
}

export function buildSubtitleAnalysisPrompt(args: {
  purpose: string
  index: string
  sourceIdentity: string
  folderContext?: string
  sourceContent: string
  maxSourceChars?: number
}): { system: string; user: string } {
  const transcript = compactSubtitleForPrompt(
    args.sourceContent,
    args.sourceIdentity,
    args.maxSourceChars ?? DEFAULT_ANALYSIS_SOURCE_CHARS,
  )

  return {
    system: [
      "You are a Chinese legal-exam course analyst. Extract a complete, structured knowledge map from subtitle transcripts.",
      "Do not output chain-of-thought, hidden reasoning, markdown prose, or comments. Return valid JSON only.",
      "",
      "The source is a course transcript, usually from SRT, LRC, or VTT subtitles. Treat timestamps as first-class evidence.",
      "Use the transcript's language for concept names and definitions. If the transcript is Chinese, output Chinese.",
      "If the input says it is one chunk of a longer transcript, analyze only that chunk, but keep absolute timestamps and concept names suitable for later consolidation.",
      "",
      "Extraction rules:",
      "- Identify every independent legal-exam knowledge point, not only broad chapter headings.",
      "- Prefer fine-grained legal concepts, elements, procedure rules, judgment standards, statutory rules, and practical exam techniques.",
      "- Preserve teacher emphasis, examples, contrasts, traps, and exam-facing wording.",
      "- Keep each knowledge point tied to the precise time range where it is explained.",
      "- Capture relationships such as prerequisite, contrast, exception, sequence, broader/narrower concept, and likely duplicate.",
      "- If a time range is approximate, still provide the best timestamp range from the transcript.",
      "",
      "Return this exact JSON shape:",
      "{",
      '  "course_overview": {',
      '    "title": "string",',
      '    "subject": "string",',
      '    "main_theme": "string",',
      '    "teacher_focus": ["string"],',
      '    "exam_orientation": "string"',
      "  },",
      '  "knowledge_points": [',
      "    {",
      '      "id": "KP001",',
      '      "concept_name": "string",',
      '      "concept_type": "定义性概念 | 构成要件 | 程序性知识 | 判断标准 | 法条规定 | 实务经验 | 其他",',
      '      "time_range": "HH:MM:SS-HH:MM:SS",',
      '      "importance_level": "high | medium | low",',
      '      "core_definition": "string",',
      '      "detailed_content": "string",',
      '      "exam_relevance": "string",',
      '      "teacher_emphasis": ["string"],',
      '      "examples": ["string"],',
      '      "common_traps": ["string"],',
      '      "relationships": [{"type": "string", "target": "string", "note": "string"}]',
      "    }",
      "  ],",
      '  "concept_structure": {',
      '    "hierarchy": [{"parent": "string", "children": ["string"]}],',
      '    "learning_sequence": ["string"]',
      "  },",
      '  "teaching_insights": {',
      '    "memory_cues": ["string"],',
      '    "exam_strategy": ["string"],',
      '    "teacher_style_notes": ["string"]',
      "  }",
      "}",
      "",
      args.purpose ? `## Wiki Purpose\n${args.purpose}` : "",
      args.index ? `## Current Wiki Index\n${args.index}` : "",
    ].filter(Boolean).join("\n"),
    user: [
      `Analyze this subtitle source: ${args.sourceIdentity}`,
      args.folderContext ? `Folder context: ${args.folderContext}` : "",
      "",
      transcript,
    ].filter(Boolean).join("\n"),
  }
}

export function buildSubtitleGenerationPrompt(baseGenerationPrompt: string): string {
  return [
    baseGenerationPrompt,
    "",
    "## Subtitle Course Mode",
    "",
    "This source is a legal-exam subtitle transcript processed with a two-stage course method.",
    "Use the Stage 1 JSON knowledge points as the primary generation plan.",
    "",
    "Create useful wiki pages as follows:",
    "- Generate a source summary page at the exact source-summary path from the base prompt.",
    "- Generate one focused concept page for each high-value legal knowledge point. Prefer one page per independent legal concept instead of one large course note.",
    "- Use the suggested path supplied for each knowledge point when present.",
    "- Preserve teacher explanations, exam traps, examples, contrasts, and memory cues from the matched subtitle segment.",
    "- Include timestamp evidence in the body when a concept has a time range. Use the timestamp links supplied in the segment context.",
    "- For Chinese law-exam material, use natural Chinese headings such as 核心定义, 构成要件, 判断标准, 例题与提示, 易混点, 记忆要点, and 与其他概念的关系.",
    "- Do not hallucinate statutes, case names, or legal rules not present in the subtitle segment or Stage 1 JSON.",
    "",
    "Your response must still follow the base prompt exactly: FILE blocks only, first characters `---FILE:`, no preamble.",
  ].join("\n")
}

export function buildSubtitleGenerationUserPrompt(args: {
  sourceIdentity: string
  analysisRaw: string
  analysis: SubtitleAnalysis
  sourceContent: string
  folderContext?: string
  maxContextChars?: number
}): string {
  const sourceContext = buildSubtitleSourceContext({
    sourceIdentity: args.sourceIdentity,
    sourceContent: args.sourceContent,
    analysis: args.analysis,
    folderContext: args.folderContext,
    maxChars: args.maxContextChars ?? DEFAULT_CONTEXT_CHARS,
  })

  return [
    `Source subtitle to process: **${args.sourceIdentity}**`,
    "",
    "The Stage 1 JSON below is the extraction plan. Do not echo it outside FILE blocks.",
    "",
    "## Stage 1 Knowledge JSON",
    "",
    args.analysisRaw.trim() || JSON.stringify(args.analysis, null, 2),
    "",
    "## Timestamped Subtitle Segments",
    "",
    sourceContext,
    "",
    "---",
    "",
    `Now emit the FILE blocks for the legal-exam wiki pages derived from **${args.sourceIdentity}**.`,
    "Your response MUST begin with `---FILE:` as the very first characters.",
    "No preamble. No analysis prose. Start immediately.",
  ].join("\n")
}

export function buildSubtitleSourceContext(args: {
  sourceIdentity: string
  sourceContent: string
  analysis: SubtitleAnalysis
  folderContext?: string
  maxChars?: number
}): string {
  const maxChars = args.maxChars ?? DEFAULT_CONTEXT_CHARS
  const lines = parseSubtitleContent(args.sourceContent, args.sourceIdentity)
  const courseUrl = extractFirstUrl(args.sourceContent)
  const segments = segmentSubtitleByKnowledgePoints({
    sourceIdentity: args.sourceIdentity,
    sourceContent: args.sourceContent,
    analysis: args.analysis,
    courseUrl,
    maxSegmentChars: Math.max(1200, Math.floor(maxChars / Math.max(1, args.analysis.knowledge_points.length + 2))),
  })

  const header = [
    `Source: ${args.sourceIdentity}`,
    args.folderContext ? `Folder context: ${args.folderContext}` : "",
    `Subtitle lines parsed: ${lines.length}`,
    courseUrl ? `Course URL: ${courseUrl}` : "",
    "",
    "Course overview:",
    jsonPreview(args.analysis.course_overview, 2500),
    "",
    "Concept structure:",
    jsonPreview(args.analysis.concept_structure, 2500),
    "",
    "Teaching insights:",
    jsonPreview(args.analysis.teaching_insights, 2500),
  ].filter(Boolean).join("\n")

  const body = segments.map((segment, idx) => [
    `## Knowledge Point ${idx + 1}: ${knowledgePointName(segment.knowledgePoint, idx)}`,
    `Suggested path: ${segment.suggestedPath}`,
    `Time range: ${segment.timeRange}`,
    "",
    "Knowledge point JSON:",
    jsonPreview(segment.knowledgePoint, 3500),
    "",
    "Matched subtitle segment:",
    segment.content,
  ].join("\n")).join("\n\n")
  const fallbackTranscript = segments.length === 0
    ? [
        "## Full Subtitle Transcript",
        compactSubtitleForPrompt(args.sourceContent, args.sourceIdentity, Math.max(2000, Math.floor(maxChars * 0.65))),
      ].join("\n")
    : ""

  const combined = `${header}\n\n${body || fallbackTranscript}`.trim()
  if (combined.length <= maxChars) return combined
  return trimAtLineBoundary(combined, maxChars)
}

export function segmentSubtitleByKnowledgePoints(args: {
  sourceIdentity: string
  sourceContent: string
  analysis: SubtitleAnalysis
  courseUrl?: string
  maxSegmentChars?: number
  bufferSeconds?: number
}): SubtitleSegment[] {
  const lines = parseSubtitleContent(args.sourceContent, args.sourceIdentity)
  const fullTranscript = lines.length > 0
    ? formatSubtitleLines(lines, args.courseUrl)
    : args.sourceContent.trim()
  const maxSegmentChars = args.maxSegmentChars ?? 6000

  return args.analysis.knowledge_points.map((kp, idx) => {
    const ranges = parseKnowledgePointRanges(kp)
    const matched = lines.length > 0
      ? selectLinesForRanges(lines, ranges, args.bufferSeconds ?? DEFAULT_SEGMENT_BUFFER_SECONDS)
      : []
    const segmentText = matched.length > 0
      ? formatSubtitleLinesWithinBudget(matched, args.courseUrl, maxSegmentChars)
      : lines.length > 0
        ? formatSubtitleLinesWithinBudget(lines, args.courseUrl, maxSegmentChars)
        : trimAtLineBoundary(fullTranscript, maxSegmentChars)
    return {
      knowledgePoint: kp,
      suggestedPath: suggestedKnowledgePointPath(kp, idx),
      timeRange: ranges.length > 0
        ? ranges.map((range) => `${formatTimestamp(range.start)}-${formatTimestamp(range.end)}`).join(", ")
        : stringifyTimeRange(kp.time_range) || "unknown",
      content: segmentText,
    }
  })
}

function chunkPlainText(text: string, maxChars: number): SubtitleAnalysisChunk[] {
  if (!text) return [{ index: 1, total: 1, lineCount: 0, content: "" }]
  const chunks: string[] = []
  let current: string[] = []
  let currentLength = 0
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const nextLength = currentLength + line.length + (current.length > 0 ? 1 : 0)
    if (current.length > 0 && nextLength > maxChars) {
      chunks.push(current.join("\n"))
      current = []
      currentLength = 0
    }
    if (line.length > maxChars) {
      if (current.length > 0) {
        chunks.push(current.join("\n"))
        current = []
        currentLength = 0
      }
      for (let i = 0; i < line.length; i += maxChars) {
        chunks.push(line.slice(i, i + maxChars))
      }
      continue
    }
    current.push(line)
    currentLength += line.length + (current.length > 1 ? 1 : 0)
  }
  if (current.length > 0) chunks.push(current.join("\n"))
  const total = chunks.length
  return chunks.map((content, idx) => ({
    index: idx + 1,
    total,
    lineCount: content.split("\n").filter((line) => line.trim()).length,
    content,
  }))
}

function parseSrtContent(content: string): SubtitleLine[] {
  const blocks = content.replace(/\r\n/g, "\n").split(/\n\s*\n/)
  const out: SubtitleLine[] = []
  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean)
    if (lines.length === 0) continue
    const timeIndex = lines.findIndex((line) => line.includes("-->"))
    if (timeIndex < 0) continue
    const parsed = parseCueTimeLine(lines[timeIndex])
    if (!parsed) continue
    const text = lines.slice(timeIndex + 1).join(" ").replace(/<[^>]+>/g, "").trim()
    if (!text) continue
    out.push({ start: parsed.start, end: parsed.end, rawTime: parsed.raw, text })
  }
  return out
}

function parseVttContent(content: string): SubtitleLine[] {
  const withoutHeader = content.replace(/^\s*WEBVTT[^\n]*(?:\n+|$)/i, "")
  return parseSrtContent(withoutHeader)
}

function parseLrcContent(content: string): SubtitleLine[] {
  const out: SubtitleLine[] = []
  const timePattern = /\[(\d{1,2}:\d{2}(?:[.:]\d{1,3})?)\]/g
  for (const line of content.replace(/\r\n/g, "\n").split("\n")) {
    const times = [...line.matchAll(timePattern)]
    if (times.length === 0) continue
    const text = line.replace(timePattern, "").trim()
    if (!text) continue
    for (const match of times) {
      const start = parseTimeToSeconds(match[1])
      if (start === null) continue
      out.push({ start, rawTime: match[1], text })
    }
  }
  out.sort((a, b) => a.start - b.start)
  for (let i = 0; i < out.length - 1; i++) {
    out[i].end = out[i + 1].start
  }
  return out
}

function parseCueTimeLine(line: string): { start: number; end: number; raw: string } | null {
  const match = /(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}|\d{1,2}:\d{2}[,.]\d{1,3}|\d{1,2}:\d{2})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}|\d{1,2}:\d{2}[,.]\d{1,3}|\d{1,2}:\d{2})/.exec(line)
  if (!match) return null
  const start = parseTimeToSeconds(match[1])
  const end = parseTimeToSeconds(match[2])
  if (start === null || end === null) return null
  return { start, end, raw: `${match[1]} --> ${match[2]}` }
}

function compactSubtitleForPrompt(content: string, path: string, maxChars: number): string {
  const lines = parseSubtitleContent(content, path)
  const compact = lines.length > 0
    ? formatSubtitleLinesWithinBudget(lines, undefined, maxChars)
    : trimAtLineBoundary(content.trim(), maxChars)
  if (compact.length <= maxChars) return compact
  return trimAtLineBoundary(compact, maxChars)
}

function formatSubtitleLines(lines: SubtitleLine[], courseUrl?: string): string {
  return lines.map((line) => formatSubtitleLine(line, courseUrl)).join("\n")
}

function formatSubtitleLinesWithinBudget(lines: SubtitleLine[], courseUrl: string | undefined, maxChars: number): string {
  if (lines.length === 0) return ""
  const out: string[] = []
  let length = 0
  for (const line of lines) {
    const rendered = formatSubtitleLine(line, courseUrl)
    const nextLength = length + rendered.length + (out.length > 0 ? 1 : 0)
    if (out.length > 0 && nextLength > maxChars) {
      out.push("[...remaining subtitle entries trimmed for prompt budget...]")
      break
    }
    out.push(rendered)
    length += rendered.length + (out.length > 1 ? 1 : 0)
  }
  return out.join("\n")
}

function formatSubtitleLine(line: SubtitleLine, courseUrl?: string): string {
  const start = formatTimestamp(line.start)
  const end = typeof line.end === "number" ? `-${formatTimestamp(line.end)}` : ""
  if (courseUrl) return `${createTimestampLink(start, courseUrl)}${end} ${line.text}`
  return `[${start}${end}] ${line.text}`
}

function parseKnowledgePointRanges(kp: SubtitleKnowledgePoint): TimeRange[] {
  const values = flattenTimeRangeValues(kp.time_range)
  const ranges: TimeRange[] = []
  for (const value of values) {
    const parsed = parseTimeRange(value)
    if (parsed) ranges.push(parsed)
  }
  return ranges
}

function parseTimeRange(value: string): TimeRange | null {
  const normalized = value.trim()
  if (!normalized) return null
  const match = /(\d{1,2}:\d{2}(?::\d{2})?(?:[,.]\d{1,3})?)\s*(?:-->|-|~|至|到)\s*(\d{1,2}:\d{2}(?::\d{2})?(?:[,.]\d{1,3})?)/.exec(normalized)
  if (match) {
    const start = parseTimeToSeconds(match[1])
    const end = parseTimeToSeconds(match[2])
    if (start === null || end === null) return null
    return { start: Math.min(start, end), end: Math.max(start, end) }
  }
  const single = parseTimeToSeconds(normalized)
  if (single === null) return null
  return { start: single, end: single }
}

function flattenTimeRangeValues(value: unknown): string[] {
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) return value.flatMap(flattenTimeRangeValues)
  if (isRecord(value)) {
    const start = value.start ?? value.begin ?? value.from
    const end = value.end ?? value.to
    if (typeof start === "string" && typeof end === "string") return [`${start}-${end}`]
  }
  return []
}

function selectLinesForRanges(lines: SubtitleLine[], ranges: TimeRange[], bufferSeconds: number): SubtitleLine[] {
  if (ranges.length === 0) return []
  return lines.filter((line) => {
    const lineEnd = line.end ?? line.start
    return ranges.some((range) => (
      line.start <= range.end + bufferSeconds && lineEnd >= range.start - bufferSeconds
    ))
  })
}

function suggestedKnowledgePointPath(kp: SubtitleKnowledgePoint, index: number): string {
  const name = knowledgePointName(kp, index)
  return `wiki/concepts/${makeQuerySlug(name)}.md`
}

function knowledgePointName(kp: SubtitleKnowledgePoint, index: number): string {
  return firstString(kp.concept_name, kp.title, kp.name, kp.id) || `knowledge-point-${index + 1}`
}

function stringifyTimeRange(value: unknown): string {
  const values = flattenTimeRangeValues(value)
  return values.join(", ")
}

function extractFirstUrl(text: string): string | undefined {
  return text.match(/https?:\/\/[^\s<>"')]+/i)?.[0]
}

function jsonPreview(value: unknown, maxChars: number): string {
  if (value === undefined || value === null || value === "") return "(none)"
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2)
  return trimLongText(text, maxChars)
}

function trimLongText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars).trimEnd()}\n[...trimmed...]`
}

function trimAtLineBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const marker = "\n[...trimmed for prompt budget...]"
  const keep = Math.max(0, maxChars - marker.length)
  const slice = text.slice(0, keep)
  const boundary = slice.lastIndexOf("\n")
  const head = boundary > Math.floor(keep * 0.5) ? slice.slice(0, boundary) : slice
  return `${head.trimEnd()}${marker}`
}

function extractJsonObject(text: string): string | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fence?.[1] ?? text
  const start = candidate.indexOf("{")
  const end = candidate.lastIndexOf("}")
  if (start < 0 || end <= start) return null
  return candidate.slice(start, end + 1)
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return ""
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function firstPresent(values: unknown[]): unknown {
  return values.find((value) => {
    if (value === undefined || value === null) return false
    if (typeof value === "string") return value.trim().length > 0
    if (Array.isArray(value)) return value.length > 0
    if (typeof value === "object") return Object.keys(value).length > 0
    return true
  })
}
