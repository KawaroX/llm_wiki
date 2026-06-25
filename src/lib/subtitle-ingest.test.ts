import { describe, expect, it } from "vitest"
import {
  buildSubtitleAnalysisChunks,
  buildSubtitleSourceContext,
  buildSubtitleSourceSummaryMarkdown,
  createTimestampLink,
  decorateSubtitleMarkdown,
  linkifySubtitleTimestamps,
  normalizeSubtitleConceptAnalysis,
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

  it("folds subtitle examples and subrules into parent concept pages", () => {
    const analysis = {
      course_overview: { title: "犯罪客体、犯罪主体", subject: "刑法" },
      knowledge_points: [
        { concept_name: "犯罪客体", time_range: "00:18-00:59" },
        { concept_name: "犯罪对象", time_range: "01:04-01:28" },
        { concept_name: "法益的解释功能", time_range: "01:36-02:55" },
        { concept_name: "非法侵入住宅罪的保护法益", time_range: "02:58-06:40" },
        { concept_name: "保护法益与保障人权的冲突", time_range: "08:46-10:27" },
        { concept_name: "肖申克救赎案：脱逃罪的认定", time_range: "10:29-13:01" },
        { concept_name: "真正身份犯（定罪身份）", time_range: "14:44-15:11" },
        { concept_name: "定罪身份的形成时间要求", time_range: "15:14-16:25" },
        { concept_name: "定罪身份只针对实行犯", time_range: "17:26-18:00" },
        { concept_name: "不真正身份犯（量刑身份）", time_range: "18:06-19:02" },
        { concept_name: "国家工作人员的认定标准（公务说）", time_range: "19:57-20:50" },
        { concept_name: "村干部是否属于国家工作人员", time_range: "23:50-24:42" },
        { concept_name: "国家工作人员身份的临时可切换性", time_range: "24:53-26:38" },
        { concept_name: "纯正的单位犯罪", time_range: "26:53-27:17" },
        { concept_name: "不纯正的单位犯罪", time_range: "27:17-27:37" },
        { concept_name: "纯正的自然人犯罪", time_range: "27:42-28:37" },
        { concept_name: "单位犯罪的主体条件（法人资格）", time_range: "28:48-30:56" },
        { concept_name: "单位犯罪的主观条件（单位意志）", time_range: "31:01-31:38" },
        { concept_name: "单位犯罪可以是过失犯罪", time_range: "31:41-32:11" },
        { concept_name: "揭开单位的面纱", time_range: "32:23-34:19" },
        { concept_name: "单位犯罪与个人犯罪的区分标准", time_range: "34:29-35:09" },
        { concept_name: "单位犯罪与个人犯罪的区分案例：集体私分", time_range: "35:46-36:56" },
        { concept_name: "单位犯罪与个人犯罪的区分案例：个人为单位谋利", time_range: "36:58-38:18" },
        { concept_name: "单位实施纯正的个人犯罪的处理", time_range: "39:07-39:45" },
        { concept_name: "单位实施不纯正的单位犯罪的处理（各算各的账）", time_range: "43:11-47:36" },
        { concept_name: "单位犯罪的处罚原则：双罚制与单罚制", time_range: "47:38-48:45" },
        { concept_name: "单位犯罪后单位消灭的刑事责任追究", time_range: "48:48-49:51" },
      ],
      concept_structure: {},
      teaching_insights: {},
    }

    const normalized = normalizeSubtitleConceptAnalysis(analysis)
    const names = normalized.knowledge_points.map((kp) => kp.concept_name)

    expect(names).toHaveLength(10)
    expect(names).toContain("犯罪客体")
    expect(names).toContain("国家工作人员的认定标准（公务说）")
    expect(names).toContain("单位犯罪与个人犯罪的区分标准")
    expect(names).not.toContain("肖申克救赎案：脱逃罪的认定")
    expect(names).not.toContain("单位犯罪与个人犯罪的区分案例：集体私分")
    expect(JSON.stringify(normalized)).toContain("单位犯罪后单位消灭的刑事责任追究")

    const markdown = buildSubtitleSourceSummaryMarkdown({
      sourceIdentity: "criminal-law.srt",
      date: "2026-06-21",
      analysis,
    })
    const relatedLine = markdown.match(/^related: (.+)$/m)?.[1] ?? ""
    expect(relatedLine).toContain("犯罪客体")
    expect(relatedLine).not.toContain("肖申克")
    expect(relatedLine).not.toContain("集体私分")
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
