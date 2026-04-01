import { cn } from "@/lib/utils"

interface DiffViewerProps {
  diff: string
  className?: string
}

export function DiffViewer({ diff, className }: DiffViewerProps) {
  const lines = diff.split("\n")

  return (
    <pre
      className={cn(
        "overflow-x-auto rounded-md bg-zinc-950 p-3 font-mono text-xs leading-5",
        className
      )}
    >
      {lines.map((line, i) => {
        let lineClass = "text-zinc-400"
        if (line.startsWith("+++") || line.startsWith("---")) {
          lineClass = "text-zinc-500"
        } else if (line.startsWith("+")) {
          lineClass = "block bg-emerald-950 text-emerald-300"
        } else if (line.startsWith("-")) {
          lineClass = "block bg-red-950 text-red-300"
        } else if (line.startsWith("@@")) {
          lineClass = "text-blue-400"
        }
        return (
          <span key={i} className={lineClass}>
            {line}
            {"\n"}
          </span>
        )
      })}
    </pre>
  )
}
