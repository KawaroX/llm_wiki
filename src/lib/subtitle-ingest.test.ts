import { describe, expect, it } from "vitest"
import {
  buildSubtitleAnalysisChunks,
  buildSubtitleSourceContext,
  buildSubtitleSourceSummaryMarkdown,
  createTimestampLink,
  decorateSubtitleMarkdown,
  linkifySubtitleTimestamps,
  parseSubtitleAnalysisResponse,
  parseSubtitleContent,
  parseTimeToSeconds,
  segmentSubtitleByKnowledgePoints,
} from "@/lib/subtitle-ingest"

describe("subtitle ingest helpers", () => {
  it("parses SRT cues with timestamps", () => {
    const content = [
      "1",
      "00:00:01,000 --> 00:00:04,500",
      "合同成立要看意思表示一致。",
      "",
      "2",
      "00:00:05,000 --> 00:00:08,000",
      "注意邀约和要约邀请的区别。",
    ].join("\n")

    const lines = parseSubtitleContent(content, "civil-law.srt")

    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({
      start: 1,
      end: 4.5,
      text: "合同成立要看意思表示一致。",
    })
    expect(lines[1].start).toBe(5)
  })

  it("parses LRC lines and derives cue ends from the next timestamp", () => {
    const content = [
      "[00:01.00]先讲犯罪构成",
      "[00:05.50]再讲违法阻却事由",
    ].join("\n")

    const lines = parseSubtitleContent(content, "criminal-law.lrc")

    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({
      start: 1,
      end: 5.5,
      text: "先讲犯罪构成",
    })
  })

  it("extracts fenced JSON analysis responses", () => {
    const parsed = parseSubtitleAnalysisResponse([
      "```json",
      "{",
      '  "course_overview": {"subject": "民法"},',
      '  "knowledge_points": [{"id": "KP001", "concept_name": "要约", "time_range": "00:00:05-00:00:10"}]',
      "}",
      "```",
    ].join("\n"))

    expect(parsed.course_overview).toEqual({ subject: "民法" })
    expect(parsed.knowledge_points).toHaveLength(1)
    expect(parsed.knowledge_points[0].concept_name).toBe("要约")
  })

  it("builds analysis chunks on subtitle entry boundaries", () => {
    const content = Array.from({ length: 5 }, (_, idx) => [
      String(idx + 1),
      `00:00:0${idx},000 --> 00:00:0${idx + 1},000`,
      `第${idx + 1}条字幕内容用于测试分块。`,
    ].join("\n")).join("\n\n")

    const chunks = buildSubtitleAnalysisChunks({
      sourceIdentity: "lecture.srt",
      sourceContent: content,
      maxChars: 70,
    })

    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.flatMap((chunk) => chunk.content.split("\n")).filter(Boolean)).toHaveLength(5)
    expect(chunks[0].content).toMatch(/^\[00:00-00:01\] 第1条字幕内容/)
    expect(chunks[0].startTime).toBe("00:00")
  })

  it("segments subtitle content by knowledge point time ranges", () => {
    const content = [
      "1",
      "00:00:01,000 --> 00:00:02,000",
      "开场。",
      "",
      "2",
      "00:00:40,000 --> 00:00:42,000",
      "要约是希望和他人订立合同的意思表示。",
      "",
      "3",
      "00:02:00,000 --> 00:02:05,000",
      "承诺到达时合同成立。",
    ].join("\n")

    const segments = segmentSubtitleByKnowledgePoints({
      sourceIdentity: "contract.srt",
      sourceContent: content,
      analysis: {
        knowledge_points: [
          {
            id: "KP001",
            concept_name: "要约",
            time_range: "00:00:39-00:00:45",
          },
        ],
      },
      bufferSeconds: 0,
    })

    expect(segments).toHaveLength(1)
    expect(segments[0].suggestedPath).toBe("wiki/concepts/要约.md")
    expect(segments[0].content).toContain("要约是希望和他人订立合同")
    expect(segments[0].content).not.toContain("承诺到达")
  })

  it("links source-summary titles to normalized concept filenames", () => {
    const markdown = buildSubtitleSourceSummaryMarkdown({
      sourceIdentity: "criminal-law.srt",
      date: "2026-06-21",
      analysis: {
        knowledge_points: [{
          concept_name: "同一用语的含义相对化（一词多义）",
          time_range: "00:29:15-00:32:06",
        }],
      },
    })

    expect(markdown).toContain(
      'related: ["[[同一用语的含义相对化一词多义|同一用语的含义相对化（一词多义）]]"]',
    )
    expect(markdown).toContain(
      "[[同一用语的含义相对化一词多义|同一用语的含义相对化（一词多义）]]",
    )
  })

  it("trims matched subtitle segments without cutting through subtitle entries", () => {
    const content = [
      "1",
      "00:00:01,000 --> 00:00:02,000",
      "第一条完整字幕。",
      "",
      "2",
      "00:00:03,000 --> 00:00:04,000",
      "第二条完整字幕。",
      "",
      "3",
      "00:00:05,000 --> 00:00:06,000",
      "第三条完整字幕。",
    ].join("\n")

    const [segment] = segmentSubtitleByKnowledgePoints({
      sourceIdentity: "lecture.srt",
      sourceContent: content,
      analysis: {
        knowledge_points: [
          {
            concept_name: "测试知识点",
            time_range: "00:00:01-00:00:06",
          },
        ],
      },
      bufferSeconds: 0,
      maxSegmentChars: 42,
    })

    expect(segment.content).toContain("第一条完整字幕")
    expect(segment.content).toContain("[...remaining subtitle entries trimmed for prompt budget...]")
    expect(segment.content).not.toMatch(/第[二三]条完整$/)
  })

  it("falls back to a compact transcript when no knowledge points parse", () => {
    const context = buildSubtitleSourceContext({
      sourceIdentity: "lecture.srt",
      sourceContent: [
        "1",
        "00:00:01,000 --> 00:00:03,000",
        "这是完整字幕。",
      ].join("\n"),
      analysis: { knowledge_points: [] },
      maxChars: 2000,
    })

    expect(context).toContain("Full Subtitle Transcript")
    expect(context).toContain("这是完整字幕")
  })

  it("formats timestamp links for video URLs", () => {
    expect(parseTimeToSeconds("01:02:03.500")).toBe(3723.5)
    expect(createTimestampLink("01:02:03", "https://www.youtube.com/watch?v=abc")).toBe(
      "[01:02:03](https://www.youtube.com/watch?v=abc&t=3723s)",
    )
    expect(createTimestampLink("00:10", "https://www.bilibili.com/video/BV1xx")).toBe(
      "[00:10](https://www.bilibili.com/video/BV1xx?t=10)",
    )
  })

  it("adds fakc course metadata and links generated timestamp ranges", () => {
    const courseUrl = "https://www.bilibili.com/video/BV1xx"
    const content = [
      "---",
      "type: source",
      'url: ""',
      "---",
      "",
      "## 时间戳",
      "",
      "- 00:01:45-00:02:35 — 犯罪构成体系",
      "- [00:06:37 - 00:10:55] — 达九罗",
    ].join("\n")

    const decorated = decorateSubtitleMarkdown(content, courseUrl, { sourcePage: true })
    expect(decorated).toContain(`url: "${courseUrl}"`)
    expect(decorated).toContain(`course_url: "${courseUrl}"`)
    expect(decorated).toContain(`[00:01:45](${courseUrl}?t=105)-[00:02:35](${courseUrl}?t=155)`)
    expect(decorated).toContain(`[00:06:37](${courseUrl}?t=397) - [00:10:55](${courseUrl}?t=655)`)

    const alreadyLinked = `[00:10](${courseUrl}?t=10) and 00:20`
    expect(linkifySubtitleTimestamps(alreadyLinked, courseUrl)).toBe(
      `[00:10](${courseUrl}?t=10) and [00:20](${courseUrl}?t=20)`,
    )
  })
})
