import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "../lib/api";

interface Part {
  partNumber: string;
  name: string;
  description: string;
}

export function PartsListPage() {
  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ partNumber: "", name: "", description: "" });
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["parts", search],
    queryFn: () => apiFetch<{ parts: Part[] }>(`/parts${search ? `?search=${encodeURIComponent(search)}` : ""}`),
  });

  const createMutation = useMutation({
    mutationFn: (payload: { partNumber: string; name: string; description: string }) =>
      apiFetch<Part>("/parts", { method: "POST", body: JSON.stringify(payload) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["parts"] });
      setShowCreate(false);
      setForm({ partNumber: "", name: "", description: "" });
    },
  });

  return (
    <main className="max-w-4xl mx-auto p-6">
      <header className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Parts</h1>
        <button type="button" onClick={() => setShowCreate((s) => !s)} className="bg-blue-600 text-white px-4 py-2 rounded">
          New Part
        </button>
      </header>

      <label htmlFor="search" className="sr-only">Search parts</label>
      <input id="search" type="search" placeholder="Search parts..." value={search} onChange={(e) => setSearch(e.target.value)} className="w-full border rounded p-2 mb-4" />

      {showCreate && (
        <form
          className="border rounded p-4 mb-4 space-y-2"
          onSubmit={(e) => { e.preventDefault(); createMutation.mutate(form); }}
          aria-label="Create part"
        >
          <div>
            <label htmlFor="pn" className="block text-sm font-medium">Part Number (PV-1001)</label>
            <input id="pn" className="border rounded p-2 w-full" value={form.partNumber} onChange={(e) => setForm({ ...form, partNumber: e.target.value })} required />
          </div>
          <div>
            <label htmlFor="name" className="block text-sm font-medium">Name</label>
            <input id="name" className="border rounded p-2 w-full" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          </div>
          <div>
            <label htmlFor="desc" className="block text-sm font-medium">Description</label>
            <textarea id="desc" className="border rounded p-2 w-full" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </div>
          {createMutation.isError && <p className="text-red-600 text-sm" role="alert">{String((createMutation.error as Error).message)}</p>}
          <button type="submit" className="bg-green-600 text-white px-4 py-2 rounded" disabled={createMutation.isPending}>
            {createMutation.isPending ? "Creating..." : "Create"}
          </button>
        </form>
      )}

      {isLoading ? <p>Loading...</p> : (
        <ul className="divide-y">
          {(data?.parts ?? []).map((p) => (
            <li key={p.partNumber} className="py-3">
              <Link to={`/parts/${p.partNumber}`} className="font-medium text-blue-600 hover:underline">{p.partNumber}</Link>
              <span className="ml-2">{p.name}</span>
              <p className="text-sm text-gray-600">{p.description}</p>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
