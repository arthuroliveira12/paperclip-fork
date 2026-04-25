/**
 * Testes do componente ApprovalViewer (T15).
 *
 * Componente standalone para a tela de Approval — exibe metadados e
 * captura decisao humana (debito/credito/categoria). O submit invoca
 * o callback `onApprove`; quem conecta isso ao tool `aprovar_classificacao`
 * eh o bundle UI do plugin (fora do escopo do componente).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ApprovalViewer } from "./approval-viewer.js";

afterEach(() => {
  cleanup();
});

const approval = {
  approval_id: "appr-42",
  fornecedor: "Posto Shell",
  descricao: "Combustivel veiculo XPTO",
  valor: 350.75,
};

describe("ApprovalViewer (T15)", () => {
  it("renderiza fornecedor, descricao, valor e os tres campos do form", () => {
    render(<ApprovalViewer approval={approval} onApprove={vi.fn()} />);

    expect(screen.getByText(/posto shell/i)).toBeTruthy();
    expect(screen.getByText(/combustivel veiculo xpto/i)).toBeTruthy();
    // valor formatado contem "350"
    expect(screen.getByTestId("approval-valor").textContent).toMatch(/350/);

    expect(screen.getByLabelText("Conta de debito")).toBeTruthy();
    expect(screen.getByLabelText("Conta de credito")).toBeTruthy();
    expect(screen.getByLabelText("Categoria")).toBeTruthy();
  });

  it("rejeita submit quando debito/credito nao sao inteiros e nao chama onApprove", () => {
    const onApprove = vi.fn();
    render(<ApprovalViewer approval={approval} onApprove={onApprove} />);

    const debito = screen.getByLabelText("Conta de debito") as HTMLInputElement;
    const credito = screen.getByLabelText(
      "Conta de credito",
    ) as HTMLInputElement;
    const categoria = screen.getByLabelText("Categoria") as HTMLInputElement;

    // debito invalido (decimal)
    fireEvent.change(debito, { target: { value: "1.5" } });
    fireEvent.change(credito, { target: { value: "200" } });
    fireEvent.change(categoria, { target: { value: "Despesas" } });

    const form = screen.getByTestId("approval-viewer-form") as HTMLFormElement;
    fireEvent.submit(form);

    expect(onApprove).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/inteiros/i);
  });

  it("chama onApprove com approval_id e decisao quando o form eh valido", () => {
    const onApprove = vi.fn();
    render(<ApprovalViewer approval={approval} onApprove={onApprove} />);

    const debito = screen.getByLabelText("Conta de debito") as HTMLInputElement;
    const credito = screen.getByLabelText(
      "Conta de credito",
    ) as HTMLInputElement;
    const categoria = screen.getByLabelText("Categoria") as HTMLInputElement;

    fireEvent.change(debito, { target: { value: "100" } });
    fireEvent.change(credito, { target: { value: "200" } });
    fireEvent.change(categoria, { target: { value: "Combustivel" } });

    const form = screen.getByTestId("approval-viewer-form") as HTMLFormElement;
    fireEvent.submit(form);

    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onApprove).toHaveBeenCalledWith({
      approval_id: "appr-42",
      decisao: { debito: 100, credito: 200, categoria: "Combustivel" },
    });
  });
});
