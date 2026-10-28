// CodeMirror 6 editor. One view; each file keeps its own state (text, cursor, undo history).
// Colors come from CSS variables, so the light/dark switch is pure CSS.

import { EditorState, StateEffect, StateField } from '@codemirror/state';
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter,
  highlightSpecialChars, drawSelection, Decoration,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
  indentOnInput, bracketMatching, syntaxHighlighting, HighlightStyle, indentUnit,
} from '@codemirror/language';
import { python } from '@codemirror/lang-python';
import { tags as t } from '@lezer/highlight';

const highlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword], color: 'var(--syn-keyword)' },
  { tag: [t.string, t.special(t.string)], color: 'var(--syn-string)' },
  { tag: [t.number, t.bool, t.null], color: 'var(--syn-number)' },
  { tag: [t.comment, t.lineComment], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.definition(t.variableName))], color: 'var(--syn-function)' },
  { tag: [t.definition(t.className), t.className], color: 'var(--syn-class)' },
  { tag: [t.self, t.special(t.variableName)], color: 'var(--syn-self)' },
  { tag: [t.operator, t.punctuation, t.bracket], color: 'var(--syn-punct)' },
  { tag: t.propertyName, color: 'var(--syn-property)' },
]);

const theme = EditorView.theme({
  '&': { height: '100%', color: 'var(--text)', backgroundColor: 'var(--editor-bg)' },
  '.cm-scroller': { fontFamily: 'var(--mono)', fontSize: 'var(--code-size)', lineHeight: '1.55' },
  '.cm-content': { caretColor: 'var(--accent)' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '.cm-gutters': { backgroundColor: 'var(--editor-bg)', color: 'var(--muted)', border: 'none' },
  '.cm-activeLine': { backgroundColor: 'var(--active-line)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--active-line)', color: 'var(--text)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--selection) !important',
  },
  '&.cm-focused .cm-matchingBracket': { backgroundColor: 'var(--bracket-match)', outline: 'none' },
  '.cm-errorLine': { backgroundColor: 'var(--error-line)' },
});

// ---------- Error line highlight ----------

const setErrorLine = StateEffect.define();
const errorLineMark = Decoration.line({ class: 'cm-errorLine' });

const errorLineField = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) {
      if (e.is(setErrorLine)) {
        if (e.value == null) return Decoration.none;
        const line = tr.state.doc.line(e.value);
        return Decoration.set([errorLineMark.range(line.from)]);
      }
    }
    return tr.docChanged ? Decoration.none : deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ---------- Editor ----------

export function createEditor(parent, { onChange, onRun }) {
  const states = new Map(); // file name -> EditorState
  let current = null;

  function extensionsFor(name) {
    const exts = [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      highlightActiveLine(),
      indentUnit.of('    '),
      EditorState.tabSize.of(4),
      keymap.of([
        { key: 'Mod-Enter', run: () => { onRun(); return true; } },
        { key: 'Mod-s', run: () => true }, // files save automatically
        indentWithTab,
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      theme,
      errorLineField,
      EditorView.updateListener.of((u) => {
        if (u.docChanged) onChange(name, u.state.doc.toString());
      }),
    ];
    if (name.endsWith('.py')) {
      exts.push(python(), indentOnInput(), bracketMatching(), syntaxHighlighting(highlightStyle));
    }
    return exts;
  }

  function makeState(name, content) {
    return EditorState.create({ doc: content, extensions: extensionsFor(name) });
  }

  const view = new EditorView({ parent, state: EditorState.create({ doc: '' }) });

  function saveCurrent() {
    if (current) states.set(current, view.state);
  }

  return {
    /** Shows a file. Creates its state the first time. */
    open(name, content) {
      saveCurrent();
      if (!states.has(name)) states.set(name, makeState(name, content));
      current = name;
      view.setState(states.get(name));
    },

    /** Replaces a file's text from outside (e.g. Python wrote to it). Loses its undo history. */
    replace(name, content) {
      if (name === current) {
        const doc = view.state.doc.toString();
        if (doc !== content) {
          view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } });
        }
      } else {
        states.set(name, makeState(name, content));
      }
    },

    rename(oldName, newName, content) {
      saveCurrent();
      states.delete(oldName);
      states.set(newName, makeState(newName, content)); // language may change with the extension
      if (current === oldName) {
        current = newName;
        view.setState(states.get(newName));
      }
    },

    forget(name) {
      states.delete(name);
      if (current === name) current = null;
    },

    get currentFile() { return current; },

    highlightLine(lineNo) {
      const doc = view.state.doc;
      const n = Math.max(1, Math.min(lineNo, doc.lines));
      const line = doc.line(n);
      view.dispatch({
        effects: [setErrorLine.of(n), EditorView.scrollIntoView(line.from, { y: 'center' })],
        selection: { anchor: line.from },
      });
      view.focus();
    },

    focus() { view.focus(); },
  };
}
