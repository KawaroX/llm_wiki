import { useEffect, useState } from "react"
import { Link2 } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { extractCourseUrl } from "@/lib/source-metadata"

export interface SubtitleCourseUrlFile {
  path: string
  name: string
  initialUrl?: string
}

interface SubtitleCourseUrlDialogProps {
  open: boolean
  files: SubtitleCourseUrlFile[]
  onOpenChange: (open: boolean) => void
  onSubmit: (courseUrls: Record<string, string>) => void
}

export function SubtitleCourseUrlDialog({
  open,
  files,
  onOpenChange,
  onSubmit,
}: SubtitleCourseUrlDialogProps) {
  const { t } = useTranslation()
  const [values, setValues] = useState<Record<string, string>>({})
  const [invalidPaths, setInvalidPaths] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (!open) return
    setValues(Object.fromEntries(files.map((file) => [file.path, file.initialUrl ?? ""])))
    setInvalidPaths(new Set())
  }, [files, open])

  function handleSubmit() {
    const normalized: Record<string, string> = {}
    const invalid = new Set<string>()
    for (const file of files) {
      const value = values[file.path]?.trim() ?? ""
      if (!value) continue
      const courseUrl = extractCourseUrl(value)
      if (!courseUrl) invalid.add(file.path)
      else normalized[file.path] = courseUrl
    }
    if (invalid.size > 0) {
      setInvalidPaths(invalid)
      return
    }
    onSubmit(normalized)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Link2 className="h-4 w-4" />
            {t("sources.subtitleCourseUrlTitle")}
          </DialogTitle>
          <DialogDescription>{t("sources.subtitleCourseUrlDescription")}</DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-6 py-4">
          {files.map((file, index) => {
            const inputId = `subtitle-course-url-${index}`
            const invalid = invalidPaths.has(file.path)
            return (
              <div key={file.path} className="flex flex-col gap-2">
                <Label htmlFor={inputId} className="break-all">{file.name}</Label>
                <Input
                  id={inputId}
                  type="url"
                  value={values[file.path] ?? ""}
                  placeholder="https://www.bilibili.com/video/BV..."
                  aria-invalid={invalid}
                  onChange={(event) => {
                    setValues((current) => ({ ...current, [file.path]: event.target.value }))
                    if (invalid) {
                      setInvalidPaths((current) => {
                        const next = new Set(current)
                        next.delete(file.path)
                        return next
                      })
                    }
                  }}
                />
                {invalid && <p className="text-xs text-destructive">{t("sources.subtitleCourseUrlInvalid")}</p>}
              </div>
            )
          })}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel", { defaultValue: "Cancel" })}
          </Button>
          <Button onClick={handleSubmit}>{t("sources.subtitleCourseUrlContinue")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
