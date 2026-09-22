import React, { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { MathfieldElement } from "mathlive";
import { readRichMathPaste } from "@/lib/richMathPaste";
import "mathlive/fonts.css";

MathfieldElement.fontsDirectory = null;
MathfieldElement.soundsDirectory = null;
MathfieldElement.computeEngine = null;

const VisualMathField = forwardRef(/**
 * @param {{ value: string, onChange: (value: string) => void, disabled?: boolean, onSubmit?: () => void, onPasteError?: (message: string) => void }} props
 * @param {any} forwardedRef
 */ function VisualMathField(props, forwardedRef) {
  const { value, onChange, disabled = false, onSubmit, onPasteError } = props;
  const elementRef = useRef(null);
  const onChangeRef = useRef(onChange);
  const onSubmitRef = useRef(onSubmit);
  const onPasteErrorRef = useRef(onPasteError);

  useEffect(() => {
    onChangeRef.current = onChange;
    onSubmitRef.current = onSubmit;
    onPasteErrorRef.current = onPasteError;
  }, [onChange, onSubmit, onPasteError]);

  useImperativeHandle(forwardedRef, () => ({
    focus: () => elementRef.current?.focus(),
    getValue: () => elementRef.current?.getValue("latex") || "",
    getErrors: () => elementRef.current?.errors || [],
    setValue: (latex) => {
      if (elementRef.current && elementRef.current.value !== latex) {
        elementRef.current.value = latex;
      }
    },
    trySetValue: (latex) => {
      const mathfield = elementRef.current;
      if (!mathfield) return false;
      const previous = mathfield.getValue("latex");
      mathfield.value = latex;
      const roundTrip = mathfield.getValue("latex");
      if (roundTrip === latex && mathfield.errors.length === 0) return true;
      mathfield.value = previous;
      return false;
    },
    executeCommand: (command) => {
      const mathfield = elementRef.current;
      if (!mathfield) return false;
      const result = mathfield.executeCommand(command);
      mathfield.focus();
      onChangeRef.current?.(mathfield.getValue("latex"));
      return result;
    },
    insert: (latex, options = {}) => {
      const mathfield = elementRef.current;
      if (!mathfield) return false;
      const inserted = mathfield.insert(latex, {
        insertionMode: "replaceSelection",
        selectionMode: "after",
        focus: true,
        feedback: false,
        ...options,
      });
      mathfield.focus();
      onChangeRef.current?.(mathfield.getValue("latex"));
      return inserted;
    },
  }), []);

  useEffect(() => {
    const mathfield = elementRef.current;
    if (!mathfield) return undefined;

    mathfield.mathVirtualKeyboardPolicy = "auto";
    mathfield.smartFence = true;
    mathfield.smartMode = false;
    mathfield.mathModeSpace = "\\,";
    mathfield.smartSuperscript = true;
    mathfield.removeExtraneousParentheses = false;
    mathfield.maxMatrixCols = 20;
    mathfield.menuItems = [];
    mathfield.placeholder = "x^2 + y^2 = 1";
    if (mathfield.value !== value) mathfield.value = value;

    const handleInput = () => onChangeRef.current?.(mathfield.getValue("latex"));
    const handleKeyDown = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        onSubmitRef.current?.();
      }
    };
    const handlePaste = (event) => {
      const result = readRichMathPaste(event.clipboardData);
      if (result.kind === "plain" || result.kind === "native") return;
      event.preventDefault();
      event.stopPropagation();
      if (result.kind === "error") {
        onPasteErrorRef.current?.(result.message);
        return;
      }
      mathfield.insert(result.latex, {
        mode: "math",
        format: "latex",
        insertionMode: "replaceSelection",
        selectionMode: "after",
        focus: true,
        feedback: false,
      });
      onChangeRef.current?.(mathfield.getValue("latex"));
    };
    mathfield.addEventListener("input", handleInput);
    mathfield.addEventListener("keydown", handleKeyDown);
    mathfield.addEventListener("paste", handlePaste, true);
    return () => {
      mathfield.removeEventListener("input", handleInput);
      mathfield.removeEventListener("keydown", handleKeyDown);
      mathfield.removeEventListener("paste", handlePaste, true);
    };
  }, []);

  useEffect(() => {
    const mathfield = elementRef.current;
    if (mathfield && mathfield.value !== value) mathfield.value = value;
  }, [value]);

  useEffect(() => {
    if (elementRef.current) elementRef.current.disabled = disabled;
  }, [disabled]);

  return React.createElement("math-field", {
    ref: elementRef,
    class: "omni-visual-mathfield",
    "aria-label": "Visual mathematics editor",
    "data-testid": "primary-math-field",
  });
});

export default VisualMathField;
