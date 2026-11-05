import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Question } from "@sentinel/shared";
import { AnswerInput } from "./AnswerInput";
import { answerText, confidenceText, isDeficient } from "../field/labels";

const q = (over: Partial<Question>): Question => ({
  id: "Q-LGT-001-01",
  text: "Are all entrances lit at night?",
  answerType: "yes_partial_no_na",
  guidance: "Walk each entrance after dark.",
  photoOnDeficiency: true,
  ...over,
});

describe("AnswerInput", () => {
  it("shows Yes, Partial, No, N/A as pressed-state buttons and reports the tap", async () => {
    const onChange = vi.fn();
    const { rerender } = render(<AnswerInput question={q({})} value={undefined} onChange={onChange} />);
    expect(screen.getByRole("group", { name: "Are all entrances lit at night?" })).toBeInTheDocument();
    for (const name of ["Yes", "Partial", "No", "N/A"]) expect(screen.getByRole("button", { name })).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(screen.getByRole("button", { name: "No" }));
    expect(onChange).toHaveBeenCalledWith({ kind: "choice", value: "no" });
    rerender(<AnswerInput question={q({})} value={{ kind: "choice", value: "no" }} onChange={onChange} />);
    expect(screen.getByRole("button", { name: /No/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("offers no Partial for yes/no questions", () => {
    render(<AnswerInput question={q({ answerType: "yes_no_na" })} value={undefined} onChange={() => undefined} />);
    expect(screen.queryByRole("button", { name: "Partial" })).toBeNull();
  });

  it("scale: every value is a button with its anchor label, and the chosen anchor's text is shown", async () => {
    const onChange = vi.fn();
    const question = q({
      answerType: "scale",
      scale: { min: 1, max: 3, anchors: [ { value: 1, label: "None", description: "No inventory exists." }, { value: 3, label: "Complete", description: "Every system is listed." } ] },
    });
    const { rerender } = render(<AnswerInput question={question} value={undefined} onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: /3\s*Complete/ }));
    expect(onChange).toHaveBeenCalledWith({ kind: "scale", value: 3 });
    rerender(<AnswerInput question={question} value={{ kind: "scale", value: 3 }} onChange={onChange} />);
    expect(screen.getByText("Every system is listed.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /2/ })).toBeInTheDocument();
  });

  it("number: keypad builds the value, shows the unit, and saves on tap", async () => {
    const onChange = vi.fn();
    render(<AnswerInput question={q({ answerType: "number", unit: "lux", text: "Measured light level at the main entrance" })} value={undefined} onChange={onChange} />);
    for (const k of ["1", "2", "Decimal point", "5"]) await userEvent.click(screen.getByRole("button", { name: k }));
    expect(screen.getByLabelText(/Measured light level at the main entrance \(lux\)/)).toHaveValue("12.5");
    await userEvent.click(screen.getByRole("button", { name: "Delete last digit" }));
    await userEvent.click(screen.getByRole("button", { name: "Save 12 lux" }));
    expect(onChange).toHaveBeenCalledWith({ kind: "number", value: 12, unit: "lux" });
  });

  it("multi select toggles options", async () => {
    const onChange = vi.fn();
    render(
      <AnswerInput
        question={q({ answerType: "multi_select", options: [ { value: "a", label: "Badge" }, { value: "b", label: "PIN" } ] })}
        value={{ kind: "select", values: ["a"] }}
        onChange={onChange}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "PIN" }));
    expect(onChange).toHaveBeenCalledWith({ kind: "select", values: ["a", "b"] });
  });
});

describe("labels", () => {
  it("confidence in words plus percent", () => {
    expect(confidenceText(0.31)).toBe("Low (31%)");
    expect(confidenceText(0.62)).toBe("Medium (62%)");
    expect(confidenceText(0.8)).toBe("High (80%)");
  });
  it("deficiency follows the compliant answer", () => {
    expect(isDeficient(q({}), { kind: "choice", value: "no" })).toBe(true);
    expect(isDeficient(q({}), { kind: "choice", value: "partial" })).toBe(false);
    expect(isDeficient(q({ compliantAnswer: "no" }), { kind: "choice", value: "yes" })).toBe(true);
    expect(answerText({ kind: "number", value: 3, unit: "ft" })).toBe("3 ft");
  });
});
