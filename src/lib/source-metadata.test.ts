import { beforeEach, describe, expect, it, vi } from "vitest"

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  readFile: fsMocks.readFile,
  writeFile: fsMocks.writeFile,
}))

import {
  extractCourseUrl,
  getSourceCourseUrl,
  saveSourceCourseUrls,
} from "@/lib/source-metadata"

beforeEach(() => {
  vi.clearAllMocks()
  fsMocks.readFile.mockRejectedValue(new Error("not found"))
  fsMocks.writeFile.mockResolvedValue(undefined)
})

describe("source course URL metadata", () => {
  it("extracts the first URL from pasted share text", () => {
    expect(extractCourseUrl("课程链接：https://www.bilibili.com/video/BV1abc?t=4 复制打开")).toBe(
      "https://www.bilibili.com/video/BV1abc?t=4",
    )
    expect(extractCourseUrl("not a URL")).toBe("")
  })

  it("reads metadata using the project-relative source path", async () => {
    fsMocks.readFile.mockResolvedValue(JSON.stringify({
      sources: {
        "raw/sources/lecture.srt": { courseUrl: "https://b23.tv/example" },
      },
    }))

    await expect(getSourceCourseUrl("/project", "/project/raw/sources/lecture.srt")).resolves.toBe(
      "https://b23.tv/example",
    )
  })

  it("persists normalized course URLs without modifying the subtitle", async () => {
    await saveSourceCourseUrls("/project", [{
      sourcePath: "/project/raw/sources/lecture.srt",
      courseUrl: "https://www.bilibili.com/video/BV1abc",
    }])

    expect(fsMocks.writeFile).toHaveBeenCalledOnce()
    const [path, raw] = fsMocks.writeFile.mock.calls[0]
    expect(path).toBe("/project/.llm-wiki/source-metadata.json")
    expect(JSON.parse(raw)).toEqual({
      sources: {
        "raw/sources/lecture.srt": {
          courseUrl: "https://www.bilibili.com/video/BV1abc",
        },
      },
    })
  })
})
