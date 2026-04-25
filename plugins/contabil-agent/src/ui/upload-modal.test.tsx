/**
 * Testes do componente UploadModal (T14).
 *
 * O componente eh standalone — recebe `empresas`, callbacks `onSubmit` e
 * `onClose`, sem dependencia direta do bridge `usePluginAction`. O caller
 * (bundle UI do plugin) eh responsavel por conectar o submit ao tool
 * `processar_fechamento`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { UploadModal } from "./upload-modal.js";

afterEach(() => {
  cleanup();
});

const empresas = [
  { id: "1", nome: "Empresa Alfa LTDA" },
  { id: "2", nome: "Empresa Beta SA" },
];

function makeFile(name: string, type: string): File {
  return new File(["x"], name, { type });
}

describe("UploadModal (T14)", () => {
  it("renderiza dropdown de empresas, input periodo e dois inputs de arquivo", () => {
    render(
      <UploadModal empresas={empresas} onSubmit={vi.fn()} onClose={vi.fn()} />,
    );

    // dropdown
    const select = screen.getByLabelText("Empresa") as HTMLSelectElement;
    expect(select.tagName).toBe("SELECT");
    expect(select.querySelectorAll("option").length).toBeGreaterThanOrEqual(
      empresas.length,
    );

    // periodo input
    const periodo = screen.getByLabelText(
      /periodo/i,
    ) as HTMLInputElement;
    expect(periodo).toBeTruthy();
    expect(periodo.getAttribute("pattern")).toBe("\\d{6}");

    // 2 file inputs
    const csv = screen.getByLabelText("CSV de despesas") as HTMLInputElement;
    const ofx = screen.getByLabelText("OFX do extrato") as HTMLInputElement;
    expect(csv.type).toBe("file");
    expect(ofx.type).toBe("file");
  });

  it("nao chama onSubmit quando submit eh disparado com campos vazios e exibe erro de periodo", () => {
    const onSubmit = vi.fn();
    render(
      <UploadModal empresas={empresas} onSubmit={onSubmit} onClose={vi.fn()} />,
    );

    // Preenche periodo invalido (formato errado), deixa o restante padrao
    const periodo = screen.getByLabelText(
      /periodo/i,
    ) as HTMLInputElement;
    fireEvent.change(periodo, { target: { value: "2025" } });

    const form = screen.getByTestId("upload-modal-form") as HTMLFormElement;
    fireEvent.submit(form);

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/periodo/i);
  });

  it("chama onSubmit com payload correto quando todos os campos sao validos", () => {
    const onSubmit = vi.fn();
    render(
      <UploadModal empresas={empresas} onSubmit={onSubmit} onClose={vi.fn()} />,
    );

    const select = screen.getByLabelText("Empresa") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "2" } });

    const periodo = screen.getByLabelText(
      /periodo/i,
    ) as HTMLInputElement;
    fireEvent.change(periodo, { target: { value: "012025" } });

    const csv = screen.getByLabelText("CSV de despesas") as HTMLInputElement;
    const ofx = screen.getByLabelText("OFX do extrato") as HTMLInputElement;
    const csvFile = makeFile("despesas.csv", "text/csv");
    const ofxFile = makeFile("extrato.ofx", "application/x-ofx");
    fireEvent.change(csv, { target: { files: [csvFile] } });
    fireEvent.change(ofx, { target: { files: [ofxFile] } });

    const form = screen.getByTestId("upload-modal-form") as HTMLFormElement;
    fireEvent.submit(form);

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({
      empresa_id: "2",
      periodo: "012025",
      csv_despesas: csvFile,
      ofx_extrato: ofxFile,
    });
  });
});
