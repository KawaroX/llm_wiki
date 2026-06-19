import { describe, expect, it } from "vitest"
import {
  buildSubtitleSourceContext,
  createTimestampLink,
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
})
