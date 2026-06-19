import { readFile, writeFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"

export interface SourceMetadata {
  courseUrl?: string
}

interface SourceMetadataFile {
  sources: Record<string, SourceMetadata>
}

function metadataPath(projectPath: string): string {
  return `${normalizePath(projectPath)}/.llm-wiki/source-metadata.json`
}

function sourceKey(projectPath: string, sourcePath: string): string {
  const project = normalizePath(projectPath).replace(/\/+$/, "")
  const source = normalizePath(sourcePath)
  return source.startsWith(`${project}/`) ? source.slice(project.length + 1) : source
}

async function loadSourceMetadata(projectPath: string): Promise<SourceMetadataFile> {
  try {
    const parsed = JSON.parse(await readFile(metadataPath(projectPath))) as Partial<SourceMetadataFile>
    return { sources: parsed.sources ?? {} }
  } catch {
    return { sources: {} }
  }
}

export function extractCourseUrl(value: string): string {
  const match = value.trim().match(/https?:\/\/[^\s]+/i)
  if (!match) return ""
  const candidate = match[0].replace(/[),，。；;]+$/, "")
  try {
    const url = new URL(candidate)
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : ""
  } catch {
    return ""
  }
}

export async function getSourceCourseUrl(projectPath: string, sourcePath: string): Promise<string> {
  const metadata = await loadSourceMetadata(projectPath)
  return metadata.sources[sourceKey(projectPath, sourcePath)]?.courseUrl ?? ""
}

export async function saveSourceCourseUrls(
  projectPath: string,
  entries: Array<{ sourcePath: string; courseUrl: string }>,
): Promise<void> {
  if (entries.length === 0) return
  const metadata = await loadSourceMetadata(projectPath)
  const sources = { ...metadata.sources }

  for (const entry of entries) {
    const key = sourceKey(projectPath, entry.sourcePath)
    const courseUrl = extractCourseUrl(entry.courseUrl)
    if (courseUrl) {
      sources[key] = { ...sources[key], courseUrl }
    } else if (sources[key]) {
      const { courseUrl: _removed, ...remaining } = sources[key]
      if (Object.keys(remaining).length > 0) sources[key] = remaining
      else delete sources[key]
    }
  }

  await writeFile(metadataPath(projectPath), JSON.stringify({ sources }, null, 2))
}

export async function removeSourceMetadata(projectPath: string, sourcePaths: string[]): Promise<void> {
  if (sourcePaths.length === 0) return
  const metadata = await loadSourceMetadata(projectPath)
  const sources = { ...metadata.sources }
  for (const sourcePath of sourcePaths) {
    delete sources[sourceKey(projectPath, sourcePath)]
  }
  await writeFile(metadataPath(projectPath), JSON.stringify({ sources }, null, 2))
}
