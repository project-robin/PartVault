import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { useState } from "react";
import { apiFetch } from "../lib/api";
import { FileUploader } from "../components/FileUploader";

interface Revision { letter: string; status: string; lock: { holder: string; expiresAt: number } | null }
interface FileDto { fileId: string; fileName: string; fileSize: number; contentType: string; sha256: string; status: string; metadata: Record<string, unknown> | null; createdAt: number }
interface HistoryEntry { entityType: string; action: string; actor: string; ts: number; details: unknown }

export function PartDetailPage() {
  const { partNumber } = useParams<{ partNumber: string }>();
  const [tab, setTab] = useState<"revisions" | "files" | "bom" | "history">("revisions");
  const [selectedRev, setSelectedRev] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const part = useQuery({ queryKey: ["part", partNumber], queryFn: () => apiFetch<{ partNumber: string; name: string; description: string }>(`/parts/${partNumber}`) });
  const revisions = useQuery({ queryKey: ["revisions", partNumber], queryFn: () => apiFetch<{ revisions: Revision[] }>(`/parts/${partNumber}/revisions`) });
  const files = useQuery({
    queryKey: ["files", partNumber, selectedRev],
    queryFn: () => apiFetch<{ files: FileDto[] }>(`/parts/${partNumber}/revisions/${selectedRev}/files`),
    enabled: !!selectedRev,
    refetchInterval: (q) => {
      const items = q.state.data?.files ?? [];
      return items.some((f) => f.status === "Processing") ? 2000 : false;
    },
  });
  const bom = useQuery({
    queryKey: ["bom", partNumber, selectedRev],
    queryFn: () => apiFetch<{ partNumber: string; revision: string; lines: { childPartNumber: string; quantity: number }[]; tree: unknown[] }>(`/parts/${partNumber}/revisions/${selectedRev}/bom`),
    enabled: !!selectedRev,
  });
  const history = useQuery({ queryKey: ["history", partNumber], queryFn: () => apiFetch<{ history: HistoryEntry[] }>(`/parts/${partNumber}/history`) });
  const whereUsed = useQuery({ queryKey: ["whereUsed", partNumber], queryFn: () => apiFetch<{ usedIn: string[] }>(`/parts/${partNumber}/where-used`) });

  const createRev = useMutation({
    mutationFn: (payload: { fromRevision?: string }) => apiFetch(`/parts/${partNumber}/revisions`, { method: "POST", body: JSON.stringify(payload) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["revisions", partNumber] }),
  });

  const transition = useMutation({
    mutationFn: ({ letter, to }: { letter: string; to: string }) => apiFetch(`/parts/${partNumber}/revisions/${letter}`, { method: "PATCH", body: JSON.stringify({ to }) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["revisions", partNumber] }),
  });

  const lockAction = useMutation({
    mutationFn: ({ letter, action }: { letter: string; action: string }) => apiFetch(`/parts/${partNumber}/revisions/${letter}`, { method: "PATCH", body: JSON.stringify({ action }) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["revisions", partNumber] }),
  });

  const saveBom = useMutation({
    mutationFn: ({ letter, lines }: { letter: string; lines: { childPartNumber: string; quantity: number }[] }) => apiFetch(`/parts/${partNumber}/revisions/${letter}/bom`, { method: "PUT", body: JSON.stringify({ lines }) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["bom", partNumber, selectedRev] }),
  });

  if (part.isLoading) return <p className="p-6">Loading...</p>;
  if (!part.data) return <p className="p-6 text-red-600">Part not found</p>;

  return (
    <main className="max-w-4xl mx-auto p-6">
      <h1 className="text-2xl font-bold">{part.data.partNumber} — {part.data.name}</h1>
      <p className="text-gray-600 mb-4">{part.data.description}</p>

      {whereUsed.data && whereUsed.data.usedIn.length > 0 && (
        <p className="text-sm mb-4">Used in: {whereUsed.data.usedIn.join(", ")}</p>
      )}

      <nav className="flex gap-2 mb-4" role="tablist" aria-label="Part tabs">
        {(["revisions", "files", "bom", "history"] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`px-3 py-1 rounded ${tab === t ? "bg-blue-600 text-white" : "bg-gray-100"}`}>
            {t[0]!.toUpperCase() + t.slice(1)}
          </button>
        ))}
      </nav>

      {tab === "revisions" && (
        <section aria-label="Revisions">
          <button type="button" className="bg-green-600 text-white px-3 py-1 rounded mb-3" onClick={() => createRev.mutate({})} disabled={createRev.isPending}>
            New revision
          </button>
          {createRev.isError && <p className="text-red-600" role="alert">{String((createRev.error as Error).message)}</p>}
          <ul className="divide-y">
            {(revisions.data?.revisions ?? []).map((r) => (
              <li key={r.letter} className="py-2 flex items-center gap-3">
                <button type="button" className="font-medium text-blue-600" onClick={() => setSelectedRev(r.letter)}>Rev {r.letter}</button>
                <span className="text-sm">{r.status}</span>
                {r.lock && <span className="text-xs bg-yellow-100 px-2 py-0.5 rounded">Locked until {new Date(r.lock.expiresAt).toLocaleString()}</span>}
                <span className="ml-auto flex gap-2">
                  {r.lock ? (
                    <button type="button" className="text-sm border px-2 py-0.5 rounded" onClick={() => lockAction.mutate({ letter: r.letter, action: "release" })}>Check in</button>
                  ) : (
                    <button type="button" className="text-sm border px-2 py-0.5 rounded" onClick={() => lockAction.mutate({ letter: r.letter, action: "acquire" })}>Check out</button>
                  )}
                  {r.status === "Draft" && <button type="button" className="text-sm border px-2 py-0.5 rounded" onClick={() => transition.mutate({ letter: r.letter, to: "In Review" })}>Submit for review</button>}
                  {r.status === "In Review" && <button type="button" className="text-sm border px-2 py-0.5 rounded" onClick={() => transition.mutate({ letter: r.letter, to: "Released" })}>Release</button>}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {tab === "files" && (
        <section aria-label="Files">
          {!selectedRev ? <p>Select a revision first.</p> : (
            <>
              <FileUploader partNumber={partNumber!} revision={selectedRev} />
              <ul className="mt-4 divide-y">
                {(files.data?.files ?? []).map((f) => (
                  <li key={f.fileId} className="py-2 text-sm">
                    <span className="font-medium">{f.fileName}</span> — {f.status}
                    {f.metadata && <span className="text-gray-600"> — {JSON.stringify(f.metadata)}</span>}
                    {f.status === "Ready" && (
                      <a className="ml-2 text-blue-600 underline" href={`/api/files/${f.fileId}/download`} target="_blank" rel="noreferrer">Download</a>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      {tab === "bom" && (
        <section aria-label="BOM">
          {!selectedRev ? <p>Select a revision first.</p> : (
            <BomEditor
              partNumber={partNumber!}
              revision={selectedRev}
              lines={bom.data?.lines ?? []}
              onSave={(lines) => saveBom.mutate({ letter: selectedRev, lines })}
              saving={saveBom.isPending}
              error={saveBom.error as Error | null}
            />
          )}
        </section>
      )}

      {tab === "history" && (
        <section aria-label="History">
          <ul className="divide-y text-sm">
            {(history.data?.history ?? []).map((h, i) => (
              <li key={i} className="py-1">
                <span className="font-medium">{h.entityType}</span> {h.action} by {h.actor} at {new Date(h.ts).toLocaleString()}
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

function BomEditor({ partNumber, revision, lines, onSave, saving, error }: {
  partNumber: string;
  revision: string;
  lines: { childPartNumber: string; quantity: number }[];
  onSave: (lines: { childPartNumber: string; quantity: number }[]) => void;
  saving: boolean;
  error: Error | null;
}) {
  const [draft, setDraft] = useState(lines);
  return (
    <div>
      <table className="w-full text-sm mb-3">
        <thead><tr><th className="text-left">Child Part</th><th className="text-left">Qty</th><th /></tr></thead>
        <tbody>
          {draft.map((l, i) => (
            <tr key={i}>
              <td><input className="border rounded px-1 w-24" value={l.childPartNumber} onChange={(e) => setDraft(draft.map((d, j) => j === i ? { ...d, childPartNumber: e.target.value } : d))} /></td>
              <td><input type="number" className="border rounded px-1 w-16" value={l.quantity} onChange={(e) => setDraft(draft.map((d, j) => j === i ? { ...d, quantity: Number(e.target.value) } : d))} /></td>
              <td><button type="button" className="text-red-600 text-xs" onClick={() => setDraft(draft.filter((_, j) => j !== i))}>Remove</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" className="text-sm border px-2 py-0.5 rounded mb-2" onClick={() => setDraft([...draft, { childPartNumber: "", quantity: 1 }])}>Add line</button>
      <div className="flex gap-2">
        <button type="button" className="bg-blue-600 text-white px-3 py-1 rounded" disabled={saving} onClick={() => onSave(draft)}>Save BOM</button>
        <a className="border px-3 py-1 rounded text-sm" href={`/api/parts/${partNumber}/revisions/${revision}/bom.csv`}>Export CSV</a>
      </div>
      {error && <p className="text-red-600 text-sm mt-2" role="alert">{error.message}</p>}
    </div>
  );
}
