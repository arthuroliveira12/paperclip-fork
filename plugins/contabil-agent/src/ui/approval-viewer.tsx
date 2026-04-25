/**
 * ApprovalViewer — UI contribution do plugin contabil-agent (T15).
 *
 * Tela de Approval: exibe metadados do lancamento pendente (fornecedor,
 * descricao, valor) e captura a decisao humana de classificacao
 * (debito, credito, categoria). O submit invoca `onApprove`; o bundle UI
 * do plugin conecta esse callback ao tool `aprovar_classificacao` via
 * `usePluginAction("aprovar_classificacao")`.
 *
 * Validacao client-side espelha a do handler do tool:
 * debito/credito devem ser inteiros e categoria nao pode ser vazia.
 *
 * Ref: T15 do plano de migracao Paperclip.
 */

import { useState, type FormEvent, type JSX } from "react";

export interface ApprovalRecord {
  approval_id: string;
  fornecedor: string;
  descricao: string;
  valor: number;
  /** Metadados adicionais opcionais (sessao_id, data, etc.). */
  [extra: string]: unknown;
}

export interface ApprovalDecisao {
  debito: number;
  credito: number;
  categoria: string;
}

export interface ApprovalSubmitPayload {
  approval_id: string;
  decisao: ApprovalDecisao;
}

export interface ApprovalViewerProps {
  approval: ApprovalRecord;
  onApprove: (payload: ApprovalSubmitPayload) => void;
}

function isIntegerString(value: string): boolean {
  if (value.trim() === "") return false;
  const n = Number(value);
  return Number.isInteger(n);
}

function formatValor(valor: number): string {
  // Evita dependencia em Intl.NumberFormat especifico — usa formato simples.
  return valor.toFixed(2);
}

export function ApprovalViewer({
  approval,
  onApprove,
}: ApprovalViewerProps): JSX.Element {
  const [debito, setDebito] = useState<string>("");
  const [credito, setCredito] = useState<string>("");
  const [categoria, setCategoria] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();

    if (!isIntegerString(debito) || !isIntegerString(credito)) {
      setError("Debito e credito devem ser numeros inteiros.");
      return;
    }
    if (categoria.trim().length === 0) {
      setError("Categoria nao pode ser vazia.");
      return;
    }

    setError(null);
    onApprove({
      approval_id: approval.approval_id,
      decisao: {
        debito: Number(debito),
        credito: Number(credito),
        categoria: categoria.trim(),
      },
    });
  }

  return (
    <section
      className="contabil-agent-approval-viewer"
      aria-labelledby="approval-viewer-title"
    >
      <header className="contabil-agent-approval-viewer__header">
        <h2 id="approval-viewer-title">Classificacao pendente</h2>
        <span className="contabil-agent-approval-viewer__id">
          #{approval.approval_id}
        </span>
      </header>

      <dl className="contabil-agent-approval-viewer__meta">
        <div>
          <dt>Fornecedor</dt>
          <dd data-testid="approval-fornecedor">{approval.fornecedor}</dd>
        </div>
        <div>
          <dt>Descricao</dt>
          <dd data-testid="approval-descricao">{approval.descricao}</dd>
        </div>
        <div>
          <dt>Valor</dt>
          <dd data-testid="approval-valor">{formatValor(approval.valor)}</dd>
        </div>
      </dl>

      <form
        className="contabil-agent-approval-viewer__form"
        onSubmit={handleSubmit}
        data-testid="approval-viewer-form"
        noValidate
      >
        <div className="contabil-agent-approval-viewer__field">
          <label htmlFor="contabil-agent-debito">Conta de debito</label>
          <input
            id="contabil-agent-debito"
            type="number"
            inputMode="numeric"
            step={1}
            value={debito}
            onChange={(e) => setDebito(e.target.value)}
            required
          />
        </div>

        <div className="contabil-agent-approval-viewer__field">
          <label htmlFor="contabil-agent-credito">Conta de credito</label>
          <input
            id="contabil-agent-credito"
            type="number"
            inputMode="numeric"
            step={1}
            value={credito}
            onChange={(e) => setCredito(e.target.value)}
            required
          />
        </div>

        <div className="contabil-agent-approval-viewer__field">
          <label htmlFor="contabil-agent-categoria">Categoria</label>
          <input
            id="contabil-agent-categoria"
            type="text"
            value={categoria}
            onChange={(e) => setCategoria(e.target.value)}
            required
          />
        </div>

        {error ? (
          <div
            className="contabil-agent-approval-viewer__error"
            role="alert"
          >
            {error}
          </div>
        ) : null}

        <div className="contabil-agent-approval-viewer__actions">
          <button type="submit">Aprovar classificacao</button>
        </div>
      </form>
    </section>
  );
}
