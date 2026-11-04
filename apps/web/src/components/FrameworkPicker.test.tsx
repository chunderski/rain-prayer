import { describe, expect, it } from "vitest";
import { useState } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FrameworkPicker } from "./FrameworkPicker";
import { computeCoverage } from "./coverage";
import { CONTROLS_BY_FRAMEWORK, FRAMEWORKS } from "../test/fixtures";

function Harness({ initial = [] as string[], controls = CONTROLS_BY_FRAMEWORK }) {
  const [value, setValue] = useState<string[]>(initial);
  return (
    <>
      <FrameworkPicker frameworks={FRAMEWORKS} value={value} onChange={setValue} controlsByFramework={controls} />
      <output data-testid="value">{value.join(",")}</output>
    </>
  );
}

const value = () => screen.getByTestId("value").textContent;
const summary = () => screen.getByTestId("picker-summary");

describe("computeCoverage", () => {
  it("deduplicates shared controls and counts overlaps", () => {
    const c = computeCoverage(["physical-general", "cpted"], CONTROLS_BY_FRAMEWORK);
    expect(c).toEqual({ controlCount: 4, overlapCount: 2, separateCount: 6, questionCount: 3 + 2 + 4 + 1, complete: true });
  });

  it("marks the result incomplete while a framework is loading", () => {
    expect(computeCoverage(["cpted", "carver"], { cpted: CONTROLS_BY_FRAMEWORK.cpted }).complete).toBe(false);
  });
});

describe("FrameworkPicker", () => {
  it("renders every framework as a labelled checkbox inside a named group", () => {
    render(<Harness />);
    const group = screen.getByRole("group", { name: "Frameworks for this assessment" });
    const boxes = within(group).getAllByRole("checkbox");
    expect(boxes).toHaveLength(5);
    expect(within(group).getByRole("checkbox", { name: "CPTED" })).toHaveAccessibleDescription(/plain-language description/);
    expect(screen.getByText(/2 items need expert review/)).toBeInTheDocument();
    expect(screen.getAllByText("Physical", { selector: "span" }).length).toBeGreaterThan(0);
  });

  it("toggles frameworks on and off with a pointer", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const cpted = screen.getByRole("checkbox", { name: "CPTED" });
    await user.click(cpted);
    expect(cpted).toBeChecked();
    expect(value()).toBe("cpted");
    await user.click(screen.getByRole("checkbox", { name: "NIST CSF 2.0" }));
    expect(value()).toBe("cpted,nist-csf-2");
    await user.click(cpted);
    expect(cpted).not.toBeChecked();
    expect(value()).toBe("nist-csf-2");
  });

  it("is operable with the keyboard alone", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    // Tab past the three preset buttons to the first framework checkbox.
    await user.tab();
    await user.tab();
    await user.tab();
    await user.tab();
    expect(screen.getByRole("checkbox", { name: "Physical" })).toHaveFocus();
    await user.keyboard(" ");
    await user.tab();
    expect(screen.getByRole("checkbox", { name: "CPTED" })).toHaveFocus();
    await user.keyboard(" ");
    expect(value()).toBe("physical-general,cpted");
  });

  it("applies presets and reflects the active preset with aria-pressed", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const physical = screen.getByRole("button", { name: /Physical site survey/ });
    await user.click(physical);
    expect(value()).toBe("physical-general,cpted,carver");
    expect(physical).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("button", { name: /Cyber and PQC/ }));
    expect(value()).toBe("nist-csf-2,pqc-readiness");
    expect(physical).toHaveAttribute("aria-pressed", "false");

    await user.click(screen.getByRole("button", { name: /Full converged/ }));
    expect(value()).toBe(FRAMEWORKS.map((f) => f.id).join(","));
  });

  it("shows live shared and overlapping control counts", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(summary()).toHaveAttribute("role", "status");
    expect(summary()).toHaveTextContent("No frameworks selected yet");
    await user.click(screen.getByRole("checkbox", { name: "Physical" }));
    expect(summary()).toHaveTextContent("1 framework selected: 3 shared controls to check, 0 of them count toward more than one framework.");
    await user.click(screen.getByRole("checkbox", { name: "CPTED" }));
    expect(summary()).toHaveTextContent("2 frameworks selected: 4 shared controls to check, 2 of them count toward more than one framework.");
    await user.click(screen.getByRole("button", { name: /Full converged/ }));
    // 7 distinct controls; LGT-001, PER-001, CRY-001 overlap.
    expect(summary()).toHaveTextContent("5 frameworks selected: 7 shared controls to check, 3 of them count toward more than one framework.");
  });

  it("says it is counting while controls load", async () => {
    const user = userEvent.setup();
    render(<Harness controls={{}} />);
    await user.click(screen.getByRole("checkbox", { name: "CARVER" }));
    expect(summary()).toHaveTextContent("Counting shared controls");
  });
});
