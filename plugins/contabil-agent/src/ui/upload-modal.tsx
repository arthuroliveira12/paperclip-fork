/**
 * UploadModal — UI contribution do plugin contabil-agent (T14).
 *
 * Modal de upload do fechamento mensal: seleciona empresa, periodo
 * (MMAAAA), CSV de despesas e OFX do extrato. O componente eh
 * intencionalmente desacoplado do bridge de plugin: recebe a lista de
 * empresas como prop e delega o submit a `onSubmit`. O bundle UI do
 * plugin (dist/ui/index.tsx) eh quem conecta `onSubmit` ao tool
 * `processar_fechamento` via `usePluginAction("processar_fechamento")`.
 *
 * Razao do desacoplamento: torna o componente trivialmente testavel
 * com React Testing Library + Vitest sem precisar carregar o runtime
 * do bridge (`__paperclipPluginBridge__`).
 *
 * Ref: T14 do plano de migracao Paperclip.
 */

import { useState, type FormEvent, type JSX } from "react";

export interface EmpresaOption {
  id: string;
  nome: string;
}

export interface UploadModalSubmitPayload {
  empresa_id: string;
  periodo: string;
  csv_despesas: File;
  ofx_extrato: File;
}

export interface UploadModalProps {
  empresas: EmpresaOption[];
  onSubmit: (payload: UploadModalSubmitPayload) => void;
  onClose: () => void;
}

const PERIODO_REGEX = /^\d{6}$/;

function validatePeriodo(value: string): string | null {
  if (!value) return "Periodo eh obrigatorio.";
  if (!PERIODO_REGEX.test(value)) {
    return "Periodo invalido: use o formato MMAAAA (6 digitos).";
  }
  const mes = Number(value.slice(0, 2));
  if (mes < 1 || mes > 12) {
    return "Periodo invalido: mes deve estar entre 01 e 12.";
  }
  return null;
}

export function UploadModal({
  empresas,
  onSubmit,
  onClose,
}: UploadModalProps): JSX.Element {
  const [empresaId, setEmpresaId] = useState<string>(empresas[0]?.id ?? "");
  const [periodo, setPeriodo] = useState<string>("");
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [ofxFile, setOfxFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();

    if (!empresaId) {
      setError("Selecione uma empresa.");
      return;
    }
    const periodoError = validatePeriodo(periodo);
    if (periodoError) {
      setError(periodoError);
      return;
    }
    if (!csvFile) {
      setError("Selecione o arquivo CSV de despesas.");
      return;
    }
    if (!ofxFile) {
      setError("Selecione o arquivo OFX do extrato.");
      return;
    }

    setError(null);
    onSubmit({
      empresa_id: empresaId,
      periodo,
      csv_despesas: csvFile,
      ofx_extrato: ofxFile,
    });
  }

  return (
    <div
      className="contabil-agent-upload-modal"
      role="dialog"
      aria-labelledby="upload-modal-title"
    >
      <div className="contabil-agent-upload-modal__header">
        <h2 id="upload-modal-title">Processar fechamento mensal</h2>
        <button
          type="button"
          className="contabil-agent-upload-modal__close"
          onClick={onClose}
          aria-label="Fechar"
        >
          x
        </button>
      </div>

      <form
        className="contabil-agent-upload-modal__form"
        onSubmit={handleSubmit}
        data-testid="upload-modal-form"
        noValidate
      >
        <div className="contabil-agent-upload-modal__field">
          <label htmlFor="contabil-agent-empresa">Empresa</label>
          <select
            id="contabil-agent-empresa"
            value={empresaId}
            onChange={(e) => setEmpresaId(e.target.value)}
            required
          >
            <option value="" disabled>
              Selecione...
            </option>
            {empresas.map((emp) => (
              <option key={emp.id} value={emp.id}>
                {emp.nome}
              </option>
            ))}
          </select>
        </div>

        <div className="contabil-agent-upload-modal__field">
          <label htmlFor="contabil-agent-periodo">Periodo (MMAAAA)</label>
          <input
            id="contabil-agent-periodo"
            type="text"
            value={periodo}
            onChange={(e) => setPeriodo(e.target.value.replace(/\D/g, ""))}
            placeholder="012025"
            inputMode="numeric"
            maxLength={6}
            pattern="\d{6}"
            required
          />
        </div>

        <div className="contabil-agent-upload-modal__field">
          <label htmlFor="contabil-agent-csv">CSV de despesas</label>
          <input
            id="contabil-agent-csv"
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => setCsvFile(e.target.files?.[0] ?? null)}
            required
          />
        </div>

        <div className="contabil-agent-upload-modal__field">
          <label htmlFor="contabil-agent-ofx">OFX do extrato</label>
          <input
            id="contabil-agent-ofx"
            type="file"
            accept=".ofx,application/x-ofx"
            onChange={(e) => setOfxFile(e.target.files?.[0] ?? null)}
            required
          />
        </div>

        {error ? (
          <div
            className="contabil-agent-upload-modal__error"
            role="alert"
          >
            {error}
          </div>
        ) : null}

        <div className="contabil-agent-upload-modal__actions">
          <button type="button" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit">Processar</button>
        </div>
      </form>
    </div>
  );
}
