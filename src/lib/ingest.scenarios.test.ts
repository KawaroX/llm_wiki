/**
 * Scenario-driven tests for autoIngest.
 *
 * Each scenario materializes an initial project, a source document, and two
 * canned LLM responses (stage 1 analysis, stage 2 generation with FILE +
 * REVIEW blocks). The runner mocks streamChat to emit them sequentially.
 *
 * After ingest runs, the runner asserts:
 *   - expected files exist on disk with expected substrings
 *   - expected review items were injected into the review store
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest"
import path from "node:path"
import fs from "node:fs/promises"
import { realFs, createTempProject, readFileRaw, writeFileRaw, fileExists } from "@/test-helpers/fs-temp"
import { materializeScenario, copyDir } from "@/test-helpers/scenarios/materialize"
import { ingestScenarios } from "@/test-helpers/scenarios/ingest-scenarios"
import type { IngestScenario } from "@/test-helpers/scenarios/types"

vi.mock("@/commands/fs", () => realFs)

// Sequenced streamChat: stage-1 returns analysisResponse, stage-2 returns
// generationResponse. Any further calls return empty (shouldn't happen in a
// typical autoIngest run).
let pendingResponses: string[] = []
vi.mock("./llm-client", () => ({
  streamChat: vi.fn(async (_cfg, _msgs, cb) => {
    const resp = pendingResponses.shift() ?? ""
    cb.onToken(resp)
    cb.onDone()
  }),
}))

import { autoIngest } from "./ingest"
import { streamChat } from "./llm-client"
import { useWikiStore } from "@/stores/wiki-store"
import { useReviewStore } from "@/stores/review-store"
import { useActivityStore } from "@/stores/activity-store"
import { useChatStore } from "@/stores/chat-store"

const mockStreamChat = vi.mocked(streamChat)

const FIXTURES_ROOT = path.join(
  process.cwd(),
  "tests",
  "fixtures",
  "scenarios-ingest",
)

beforeAll(async () => {
  await fs.rm(FIXTURES_ROOT, { recursive: true, force: true })
  await fs.mkdir(FIXTURES_ROOT, { recursive: true })
  for (const s of ingestScenarios) {
    await materializeScenario(s, FIXTURES_ROOT)
  }
})

beforeEach(() => {
  pendingResponses = []
  mockStreamChat.mockClear()
  useReviewStore.setState({ items: [] })
  useActivityStore.setState({ items: [] })
  useChatStore.setState({
    conversations: [],
    messages: [],
    activeConversationId: null,
    mode: "chat",
    ingestSource: null,
    isStreaming: false,
    streamingContent: "",
  })
})

interface Ctx {
  tmp: { path: string; cleanup: () => Promise<void> }
}
let ctx: Ctx | undefined

async function setup(scenario: IngestScenario): Promise<Ctx> {
  const tmp = await createTempProject(
    `ingest-${scenario.name.replace(/\//g, "-")}`,
  )
  const initialWikiDir = path.join(FIXTURES_ROOT, scenario.name, "initial-wiki")
  await copyDir(initialWikiDir, tmp.path)

  useWikiStore.setState({
    project: {
      name: "t",
      path: tmp.path,
      createdAt: 0,
      purposeText: "",
      fileTree: [],
    } as unknown as ReturnType<typeof useWikiStore.getState>["project"],
  })
  useWikiStore.getState().setLlmConfig({
    provider: "openai",
    apiKey: "test-key",
    model: "gpt-4",
    ollamaUrl: "",
    customEndpoint: "",
    maxContextSize: 128000,
  })

  // Queue up the two sequenced LLM responses
  const analysis = await fs.readFile(
    path.join(FIXTURES_ROOT, scenario.name, "llm-analysis.txt"),
    "utf-8",
  )
  const generation = await fs.readFile(
    path.join(FIXTURES_ROOT, scenario.name, "llm-generation.txt"),
    "utf-8",
  )
  pendingResponses = [analysis, generation]

  return { tmp }
}

afterEach(async () => {
  if (ctx) {
    await ctx.tmp.cleanup()
    ctx = undefined
  }
})

// ── Assertions ──────────────────────────────────────────────────────────────

async function assertOutcome(
  scenario: IngestScenario,
  tmpPath: string,
): Promise<void> {
  const expected = scenario.expected

  // 1. Expected files exist
  for (const p of expected.writtenPaths) {
    const full = path.join(tmpPath, p)
    const exists = await fileExists(full)
    if (!exists) {
      // eslint-disable-next-line no-console
      console.error(
        `\n[ingest: ${scenario.name}] expected file not written: ${p}`,
      )
    }
    expect(exists, `file not written: ${p}`).toBe(true)
  }

  // 2. File contents contain expected substrings
  if (expected.fileContains) {
    for (const [relPath, substrs] of Object.entries(expected.fileContains)) {
      const full = path.join(tmpPath, relPath)
      const content = await readFileRaw(full)
      for (const sub of substrs) {
        expect(content, `${relPath} missing substring "${sub}"`).toContain(sub)
      }
    }
  }

  // 3. Review store has the expected items
  const expectedReviews = expected.reviewsCreated ?? []
  const actualReviews = useReviewStore.getState().items
  for (const e of expectedReviews) {
    const match = actualReviews.find(
      (r) => r.type === e.type && r.title.includes(e.titleContains),
    )
    if (!match) {
      // eslint-disable-next-line no-console
      console.error(
        `\n[ingest: ${scenario.name}] no review matching ${JSON.stringify(e)}. Actual:\n` +
          JSON.stringify(
            actualReviews.map((r) => ({ type: r.type, title: r.title })),
            null,
            2,
          ),
      )
    }
    expect(match, `review missing: ${JSON.stringify(e)}`).toBeTruthy()
  }

  // 4. If the scenario declared no reviews, store must be empty.
  if (expectedReviews.length === 0) {
    expect(actualReviews).toHaveLength(0)
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("ingest scenarios (fixture-driven)", () => {
  it.each(ingestScenarios.map((s) => [s.name, s]))(
    "%s",
    async (_name, scenario) => {
      ctx = await setup(scenario)

      const sourceFullPath = path.join(ctx.tmp.path, scenario.source.path)
      await autoIngest(
        ctx.tmp.path,
        sourceFullPath,
        useWikiStore.getState().llmConfig,
      )

      await assertOutcome(scenario, ctx.tmp.path)
    },
  )

  it("runs the subtitle-specific two-stage pipeline and writes SRT-derived pages", async () => {
    ctx = { tmp: await createTempProject("ingest-subtitle-srt") }
    const projectPath = ctx.tmp.path
    const sourcePath = `${projectPath}/raw/sources/law-lecture.srt`

    await writeFileRaw(`${projectPath}/purpose.md`, "# Purpose\n\n法考知识库。\n")
    await writeFileRaw(`${projectPath}/wiki/index.md`, "# Index\n")
    await writeFileRaw(`${projectPath}/wiki/overview.md`, "# Overview\n")
    await writeFileRaw(
      sourcePath,
      [
        "1",
        "00:00:01,000 --> 00:00:04,000",
        "要约是希望和他人订立合同的意思表示。",
        "",
        "2",
        "00:00:05,000 --> 00:00:08,000",
        "要约的内容应当具体确定。",
      ].join("\n"),
    )
    await writeFileRaw(
      `${projectPath}/.llm-wiki/source-metadata.json`,
      JSON.stringify({
        sources: {
          "raw/sources/law-lecture.srt": {
            courseUrl: "https://www.bilibili.com/video/BV1course",
          },
        },
      }),
    )

    useWikiStore.setState({
      project: {
        name: "t",
        path: projectPath,
        createdAt: 0,
        purposeText: "",
        fileTree: [],
      } as unknown as ReturnType<typeof useWikiStore.getState>["project"],
    })
    useWikiStore.getState().setLlmConfig({
      provider: "openai",
      apiKey: "test-key",
      model: "gpt-4",
      ollamaUrl: "",
      customEndpoint: "",
      maxContextSize: 128000,
    })

    pendingResponses = [
      JSON.stringify({
        course_overview: {
          title: "合同法课程",
          subject: "民法",
          main_theme: "要约",
        },
        knowledge_points: [
          {
            id: "KP001",
            concept_name: "要约",
            concept_type: "定义性概念",
            time_range: "00:00:01-00:00:08",
            core_definition: "希望和他人订立合同的意思表示。",
          },
        ],
        concept_structure: {},
        teaching_insights: {},
      }),
      [
        "---FILE: wiki/sources/law-lecture.md---",
        "---",
        "type: source",
        'title: "Source: law-lecture.srt"',
        "created: 2026-06-19",
        "updated: 2026-06-19",
        "tags: [法考, 民法]",
        "related: [要约]",
        'sources: ["law-lecture.srt"]',
        "---",
        "",
        "# 合同法课程",
        "",
        "本课程讲解要约。",
        "---END FILE---",
        "",
        "---FILE: wiki/concepts/要约.md---",
        "---",
        "type: concept",
        'title: "要约"',
        "created: 2026-06-19",
        "updated: 2026-06-19",
        "tags: [法考, 民法, 合同法]",
        "related: []",
        'sources: ["law-lecture.srt"]',
        "---",
        "",
        "# 要约",
        "",
        "## 核心定义",
        "",
        "要约是希望和他人订立合同的意思表示。",
        "",
        "## 时间戳",
        "",
        "00:00:01-00:00:08",
        "---END FILE---",
      ].join("\n"),
    ]

    const written = await autoIngest(
      projectPath,
      sourcePath,
      useWikiStore.getState().llmConfig,
    )

    expect(written).toEqual(expect.arrayContaining([
      "wiki/sources/law-lecture.md",
      "wiki/concepts/要约.md",
    ]))
    const sourcePage = await readFileRaw(`${projectPath}/wiki/sources/law-lecture.md`)
    const conceptPage = await readFileRaw(`${projectPath}/wiki/concepts/要约.md`)
    expect(sourcePage).toContain("合同法课程")
    expect(sourcePage).toContain('url: "https://www.bilibili.com/video/BV1course"')
    expect(sourcePage).toContain('course_url: "https://www.bilibili.com/video/BV1course"')
    expect(conceptPage).toContain("要约是希望和他人订立合同")
    expect(conceptPage).toContain('course_url: "https://www.bilibili.com/video/BV1course"')
    expect(conceptPage).toContain("[00:00:01](https://www.bilibili.com/video/BV1course?t=1)")
    expect(conceptPage).toContain("[00:00:08](https://www.bilibili.com/video/BV1course?t=8)")

    const analysisCall = mockStreamChat.mock.calls.find(([, messages]) =>
      typeof messages[0]?.content === "string" &&
      messages[0].content.includes("Chinese legal-exam course analyst"),
    )
    const generationCall = mockStreamChat.mock.calls.find(([, messages]) =>
      typeof messages[0]?.content === "string" &&
      messages[0].content.includes("Subtitle Course Mode"),
    )
    expect(analysisCall).toBeTruthy()
    expect(generationCall).toBeTruthy()
    expect(generationCall?.[1][1].content).toContain("Matched subtitle segment")
    expect(generationCall?.[1][1].content).toContain("要约的内容应当具体确定")
    expect(generationCall?.[1][1].content).toContain("Course URL: https://www.bilibili.com/video/BV1course")
    expect(generationCall?.[1][1].content).toContain("https://www.bilibili.com/video/BV1course?t=1")
  })

  it("drops generated pages whose frontmatter type disagrees with schema routing", async () => {
    ctx = { tmp: await createTempProject("ingest-schema-routing") }
    const projectPath = ctx.tmp.path

    await writeFileRaw(
      `${projectPath}/schema.md`,
      [
        "# Wiki Schema",
        "",
        "## Page Types",
        "",
        "| Type | Directory | Purpose |",
        "| ---- | --------- | ------- |",
        "| source | wiki/sources/ | Source summaries |",
        "| concept | wiki/concepts/ | Ideas |",
      ].join("\n"),
    )
    await writeFileRaw(`${projectPath}/purpose.md`, "")
    await writeFileRaw(`${projectPath}/wiki/index.md`, "# Index\n")
    await writeFileRaw(`${projectPath}/wiki/overview.md`, "# Overview\n")
    await writeFileRaw(`${projectPath}/raw/sources/schema-routing.md`, "source\n")

    useWikiStore.setState({
      project: {
        name: "t",
        path: projectPath,
        createdAt: 0,
        purposeText: "",
        fileTree: [],
      } as unknown as ReturnType<typeof useWikiStore.getState>["project"],
    })
    useWikiStore.getState().setLlmConfig({
      provider: "openai",
      apiKey: "test-key",
      model: "gpt-4",
      ollamaUrl: "",
      customEndpoint: "",
      maxContextSize: 128000,
    })

    pendingResponses = [
      "analysis",
      [
        "---FILE: wiki/sources/schema-routing.md---",
        "---",
        "type: source",
        "title: Source: schema-routing.md",
        "sources: [schema-routing.md]",
        "tags: []",
        "related: []",
        "---",
        "",
        "# Source: schema-routing.md",
        "---END FILE---",
        "",
        "---FILE: wiki/concepts/wrong-place.md---",
        "---",
        "type: source",
        "title: Wrong Place",
        "sources: [schema-routing.md]",
        "tags: []",
        "related: []",
        "---",
        "",
        "# Wrong Place",
        "---END FILE---",
      ].join("\n"),
    ]

    const written = await autoIngest(
      projectPath,
      `${projectPath}/raw/sources/schema-routing.md`,
      useWikiStore.getState().llmConfig,
    )

    expect(written).not.toContain("wiki/concepts/wrong-place.md")
    expect(await fileExists(`${projectPath}/wiki/concepts/wrong-place.md`)).toBe(false)
  })

  it("keeps source summaries distinct for same basenames in different source folders", async () => {
    ctx = { tmp: await createTempProject("ingest-duplicate-source-basenames") }
    const projectPath = ctx.tmp.path

    await writeFileRaw(`${projectPath}/schema.md`, "")
    await writeFileRaw(`${projectPath}/purpose.md`, "")
    await writeFileRaw(`${projectPath}/wiki/index.md`, "# Index\n")
    await writeFileRaw(`${projectPath}/wiki/overview.md`, "")
    await writeFileRaw(`${projectPath}/raw/sources/project-a/config.yaml`, "name: project-a\n")
    await writeFileRaw(`${projectPath}/raw/sources/project-b/config.yaml`, "name: project-b\n")

    useWikiStore.setState({
      project: {
        name: "t",
        path: projectPath,
        createdAt: 0,
        purposeText: "",
        fileTree: [],
      } as unknown as ReturnType<typeof useWikiStore.getState>["project"],
    })
    useWikiStore.getState().setLlmConfig({
      provider: "openai",
      apiKey: "test-key",
      model: "gpt-4",
      ollamaUrl: "",
      customEndpoint: "",
      maxContextSize: 128000,
    })

    pendingResponses = [
      "analysis for project A",
      [
        "---FILE: wiki/sources/config.md---",
        "---",
        'type: "source"',
        'title: "Source: config.yaml"',
        'sources: ["config.yaml"]',
        "tags: []",
        "related: []",
        "---",
        "",
        "# Project A",
        "",
        "analysis for project A",
        "---END FILE---",
      ].join("\n"),
      "analysis for project B",
      [
        "---FILE: wiki/sources/config.md---",
        "---",
        'type: "source"',
        'title: "Source: config.yaml"',
        'sources: ["config.yaml"]',
        "tags: []",
        "related: []",
        "---",
        "",
        "# Project B",
        "",
        "analysis for project B",
        "---END FILE---",
      ].join("\n"),
    ]

    const cfg = useWikiStore.getState().llmConfig
    const firstWritten = await autoIngest(
      projectPath,
      `${projectPath}/raw/sources/project-a/config.yaml`,
      cfg,
    )
    const secondWritten = await autoIngest(
      projectPath,
      `${projectPath}/raw/sources/project-b/config.yaml`,
      cfg,
    )

    expect(firstWritten).toContain("wiki/sources/9-project-a--6-config--3eym4.md")
    expect(secondWritten).toContain("wiki/sources/9-project-b--6-config--177z4nx.md")
    expect(await fileExists(`${projectPath}/wiki/sources/config.md`)).toBe(false)

    const projectA = await readFileRaw(`${projectPath}/wiki/sources/9-project-a--6-config--3eym4.md`)
    const projectB = await readFileRaw(`${projectPath}/wiki/sources/9-project-b--6-config--177z4nx.md`)
    expect(projectA).toContain('sources: ["project-a/config.yaml"]')
    expect(projectA).toContain("analysis for project A")
    expect(projectB).toContain('sources: ["project-b/config.yaml"]')
    expect(projectB).toContain("analysis for project B")
  })
})
