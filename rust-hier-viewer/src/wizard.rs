use std::path::Path;
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use std::time::Duration;

use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyModifiers};
use crossterm::execute;
use crossterm::terminal::{
    EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode,
};
use ratatui::Terminal;
use ratatui::backend::CrosstermBackend;
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, List, ListItem, ListState, Paragraph, Wrap};

use crate::launcher::{FileIndex, PatternMode, StartupSelection, parse_extra_args};
use crate::model::Config;

const DEFAULT_OUTPUT_DIR: &str = "hier-viewer-out";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Field {
    PatternMode,
    RtlPathInput,
    FilelistInput,
    SourceList,
    ExtraArgs,
    OutputDir,
    Title,
    Run,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum WizardTab {
    Input,
    Flags,
    Output,
}

impl WizardTab {
    const ALL: [WizardTab; 3] = [WizardTab::Input, WizardTab::Flags, WizardTab::Output];

    fn label(self) -> &'static str {
        match self {
            WizardTab::Input => "Sources",
            WizardTab::Flags => "Flags",
            WizardTab::Output => "Output",
        }
    }

    fn short_index(self) -> &'static str {
        match self {
            WizardTab::Input => "01",
            WizardTab::Flags => "02",
            WizardTab::Output => "03",
        }
    }

    fn summary(self) -> &'static str {
        match self {
            WizardTab::Input => "Add RTL paths, wildcard/regex matches, and optional filelists.",
            WizardTab::Flags => "Append +incdir, +define, --top, and other parser flags.",
            WizardTab::Output => "Choose the bundle directory and an optional short viewer title.",
        }
    }

    fn first_field(self) -> Field {
        match self {
            WizardTab::Input => Field::PatternMode,
            WizardTab::Flags => Field::ExtraArgs,
            WizardTab::Output => Field::OutputDir,
        }
    }

    fn index(self) -> usize {
        Self::ALL.iter().position(|tab| *tab == self).unwrap_or(0)
    }

    fn next(self) -> Self {
        Self::ALL[(self.index() + 1) % Self::ALL.len()]
    }

    fn prev(self) -> Self {
        Self::ALL[(self.index() + Self::ALL.len() - 1) % Self::ALL.len()]
    }

    fn of_field(field: Field) -> Self {
        match field {
            Field::PatternMode | Field::RtlPathInput | Field::FilelistInput | Field::SourceList => {
                WizardTab::Input
            }
            Field::ExtraArgs => WizardTab::Flags,
            Field::OutputDir | Field::Title | Field::Run => WizardTab::Output,
        }
    }
}

impl Field {
    const ALL: [Field; 8] = [
        Field::PatternMode,
        Field::RtlPathInput,
        Field::FilelistInput,
        Field::SourceList,
        Field::ExtraArgs,
        Field::OutputDir,
        Field::Title,
        Field::Run,
    ];

    fn next(self) -> Self {
        let index = Self::ALL
            .iter()
            .position(|field| *field == self)
            .unwrap_or(0);
        Self::ALL[(index + 1) % Self::ALL.len()]
    }

    fn prev(self) -> Self {
        let index = Self::ALL
            .iter()
            .position(|field| *field == self)
            .unwrap_or(0);
        Self::ALL[(index + Self::ALL.len() - 1) % Self::ALL.len()]
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SuggestionTarget {
    RtlPath,
    Filelist,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SourceEntryKind {
    RtlPath,
    Filelist,
}

impl SourceEntryKind {
    fn badge(self) -> &'static str {
        match self {
            SourceEntryKind::RtlPath => "RTL",
            SourceEntryKind::Filelist => "FILELIST",
        }
    }
}

#[derive(Clone, Debug)]
struct SourceEntry {
    kind: SourceEntryKind,
    value: String,
    matched_files: Option<usize>,
}

struct WizardState {
    selected: Field,
    pattern_mode: PatternMode,
    pattern_mode_open: bool,
    rtl_path_input: String,
    rtl_path_editing: bool,
    filelist_input: String,
    filelist_editing: bool,
    sources: Vec<SourceEntry>,
    source_index: usize,
    extra_args: String,
    output_dir: String,
    title: String,
    status: String,
    suggestions: Vec<String>,
    suggestion_index: usize,
    suggestion_explicitly_selected: bool,
    latest_suggestion_seq: u64,
    suggestion_target: Option<SuggestionTarget>,
}

#[derive(Clone)]
struct SuggestionRequest {
    seq: u64,
    mode: PatternMode,
    target: SuggestionTarget,
    input: String,
}

#[derive(Clone)]
struct SuggestionResponse {
    seq: u64,
    mode: PatternMode,
    target: SuggestionTarget,
    suggestions: Vec<String>,
}

struct InputTabLayout {
    mode: Rect,
    rtl_input: Rect,
    filelist_input: Rect,
    source_list: Rect,
    help: Rect,
}

impl WizardState {
    fn new(config: &Config, file_index: &FileIndex) -> Self {
        Self {
            selected: Field::RtlPathInput,
            pattern_mode: PatternMode::Wildcard,
            pattern_mode_open: false,
            rtl_path_input: String::new(),
            rtl_path_editing: true,
            filelist_input: String::new(),
            filelist_editing: false,
            sources: Vec::new(),
            source_index: 0,
            extra_args: shell_words::join(&config.extra_args_tokens),
            output_dir: config
                .output_path
                .clone()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| DEFAULT_OUTPUT_DIR.to_string()),
            title: config.title.clone().unwrap_or_default(),
            status: format!(
                "Scanned {} RTL files from the current workspace. Add RTL paths and optional filelists into the source list, then run slang-hier-exporter --sqlite internally.",
                file_index.file_count()
            ),
            suggestions: Vec::new(),
            suggestion_index: 0,
            suggestion_explicitly_selected: false,
            latest_suggestion_seq: 0,
            suggestion_target: None,
        }
    }
}

pub(crate) fn run_startup_wizard(
    config: &Config,
    file_index: &FileIndex,
) -> Result<StartupSelection, String> {
    enable_raw_mode().map_err(|err| format!("failed to enable raw mode: {err}"))?;
    let mut stdout = std::io::stdout();
    execute!(stdout, EnterAlternateScreen)
        .map_err(|err| format!("failed to enter alternate screen: {err}"))?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal =
        Terminal::new(backend).map_err(|err| format!("failed to initialize terminal: {err}"))?;

    let mut state = WizardState::new(config, file_index);

    let (request_tx, response_rx) = spawn_suggestion_worker(file_index.clone());
    request_suggestions(&request_tx, &mut state);

    let result = (|| -> Result<StartupSelection, String> {
        loop {
            drain_suggestion_updates(&response_rx, &mut state);
            terminal
                .draw(|frame| render(frame, &state))
                .map_err(|err| format!("failed to draw startup wizard: {err}"))?;

            if event::poll(Duration::from_millis(200))
                .map_err(|err| format!("failed to poll terminal events: {err}"))?
            {
                let Event::Key(key) =
                    event::read().map_err(|err| format!("failed to read terminal event: {err}"))?
                else {
                    continue;
                };

                if let Some(selection) = handle_key(key, &mut state, file_index, &request_tx)? {
                    return Ok(selection);
                }
            }
        }
    })();

    disable_raw_mode().map_err(|err| format!("failed to disable raw mode: {err}"))?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen)
        .map_err(|err| format!("failed to leave alternate screen: {err}"))?;
    terminal
        .show_cursor()
        .map_err(|err| format!("failed to restore terminal cursor: {err}"))?;

    result
}

fn handle_key(
    key: KeyEvent,
    state: &mut WizardState,
    file_index: &FileIndex,
    request_tx: &Sender<SuggestionRequest>,
) -> Result<Option<StartupSelection>, String> {
    if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
        return Err("startup wizard cancelled".to_string());
    }

    match key.code {
        KeyCode::Esc => {
            if state.selected == Field::PatternMode && state.pattern_mode_open {
                state.pattern_mode_open = false;
                return Ok(None);
            }
            if stop_active_input_editing(state) {
                request_suggestions(request_tx, state);
                return Ok(None);
            }
            return Err("startup wizard cancelled".to_string());
        }
        KeyCode::PageUp => {
            clear_transient_state(state);
            state.selected = WizardTab::of_field(state.selected).prev().first_field();
            return Ok(None);
        }
        KeyCode::PageDown => {
            clear_transient_state(state);
            state.selected = WizardTab::of_field(state.selected).next().first_field();
            return Ok(None);
        }
        KeyCode::Tab => {
            if active_input_editing(state) && !state.suggestions.is_empty() {
                state.suggestion_index = (state.suggestion_index + 1) % state.suggestions.len();
                state.suggestion_explicitly_selected = true;
            } else {
                clear_transient_state(state);
                state.selected = state.selected.next();
                request_suggestions(request_tx, state);
            }
            return Ok(None);
        }
        KeyCode::BackTab => {
            if active_input_editing(state) && !state.suggestions.is_empty() {
                state.suggestion_index = state
                    .suggestion_index
                    .checked_sub(1)
                    .unwrap_or_else(|| state.suggestions.len().saturating_sub(1));
                state.suggestion_explicitly_selected = true;
            } else {
                clear_transient_state(state);
                state.selected = state.selected.prev();
                request_suggestions(request_tx, state);
            }
            return Ok(None);
        }
        KeyCode::Down => {
            if state.selected == Field::PatternMode && state.pattern_mode_open {
                state.pattern_mode = state.pattern_mode.next();
                refresh_source_counts(state, file_index);
                request_suggestions(request_tx, state);
            } else if active_input_editing(state) && !state.suggestions.is_empty() {
                state.suggestion_index = (state.suggestion_index + 1) % state.suggestions.len();
                state.suggestion_explicitly_selected = true;
            } else if state.selected == Field::SourceList && !state.sources.is_empty() {
                state.source_index = (state.source_index + 1) % state.sources.len();
            } else {
                clear_transient_state(state);
                state.selected = state.selected.next();
                request_suggestions(request_tx, state);
            }
            return Ok(None);
        }
        KeyCode::Up => {
            if state.selected == Field::PatternMode && state.pattern_mode_open {
                state.pattern_mode = state.pattern_mode.prev();
                refresh_source_counts(state, file_index);
                request_suggestions(request_tx, state);
            } else if active_input_editing(state) && !state.suggestions.is_empty() {
                state.suggestion_index = state
                    .suggestion_index
                    .checked_sub(1)
                    .unwrap_or_else(|| state.suggestions.len().saturating_sub(1));
                state.suggestion_explicitly_selected = true;
            } else if state.selected == Field::SourceList && !state.sources.is_empty() {
                state.source_index = state
                    .source_index
                    .checked_sub(1)
                    .unwrap_or_else(|| state.sources.len().saturating_sub(1));
            } else {
                clear_transient_state(state);
                state.selected = state.selected.prev();
                request_suggestions(request_tx, state);
            }
            return Ok(None);
        }
        KeyCode::Left | KeyCode::Right if key.modifiers.contains(KeyModifiers::CONTROL) => {
            clear_transient_state(state);
            state.selected = if key.code == KeyCode::Left {
                WizardTab::of_field(state.selected).prev().first_field()
            } else {
                WizardTab::of_field(state.selected).next().first_field()
            };
            request_suggestions(request_tx, state);
            return Ok(None);
        }
        KeyCode::Enter => match state.selected {
            Field::PatternMode => {
                state.pattern_mode_open = !state.pattern_mode_open;
                return Ok(None);
            }
            Field::RtlPathInput => {
                handle_source_input_enter(state, request_tx, file_index, SourceEntryKind::RtlPath);
                return Ok(None);
            }
            Field::FilelistInput => {
                handle_source_input_enter(state, request_tx, file_index, SourceEntryKind::Filelist);
                return Ok(None);
            }
            Field::Run => return build_selection(state, file_index),
            _ => {
                clear_transient_state(state);
                state.selected = state.selected.next();
                request_suggestions(request_tx, state);
                return Ok(None);
            }
        },
        KeyCode::Delete => {
            if state.selected == Field::SourceList {
                remove_selected_source(state, file_index);
            }
            return Ok(None);
        }
        KeyCode::Backspace => {
            match state.selected {
                Field::RtlPathInput => {
                    state.rtl_path_input.pop();
                    state.rtl_path_editing = true;
                    request_suggestions(request_tx, state);
                }
                Field::FilelistInput => {
                    state.filelist_input.pop();
                    state.filelist_editing = true;
                    request_suggestions(request_tx, state);
                }
                Field::SourceList => remove_selected_source(state, file_index),
                Field::ExtraArgs | Field::OutputDir | Field::Title => {
                    active_text_mut(state).pop();
                }
                Field::PatternMode | Field::Run => {}
            }
            return Ok(None);
        }
        KeyCode::Char(ch) => {
            if key.modifiers.contains(KeyModifiers::CONTROL) {
                return Ok(None);
            }
            if state.selected == Field::SourceList && matches!(ch, 'd' | 'x') {
                remove_selected_source(state, file_index);
                return Ok(None);
            }
            match state.selected {
                Field::PatternMode | Field::SourceList | Field::Run => {
                    clear_transient_state(state);
                    state.selected = Field::RtlPathInput;
                    state.rtl_path_editing = true;
                    state.rtl_path_input.push(ch);
                    request_suggestions(request_tx, state);
                }
                Field::RtlPathInput => {
                    state.rtl_path_editing = true;
                    state.rtl_path_input.push(ch);
                    request_suggestions(request_tx, state);
                }
                Field::FilelistInput => {
                    state.filelist_editing = true;
                    state.filelist_input.push(ch);
                    request_suggestions(request_tx, state);
                }
                Field::ExtraArgs | Field::OutputDir | Field::Title => {
                    active_text_mut(state).push(ch);
                }
            }
            return Ok(None);
        }
        _ => {}
    }

    Ok(None)
}

fn handle_source_input_enter(
    state: &mut WizardState,
    request_tx: &Sender<SuggestionRequest>,
    file_index: &FileIndex,
    kind: SourceEntryKind,
) {
    match kind {
        SourceEntryKind::RtlPath if !state.rtl_path_editing => {
            state.rtl_path_editing = true;
            request_suggestions(request_tx, state);
            return;
        }
        SourceEntryKind::Filelist if !state.filelist_editing => {
            state.filelist_editing = true;
            request_suggestions(request_tx, state);
            return;
        }
        _ => {}
    }

    if apply_selected_suggestion_if_needed(state, kind) {
        request_suggestions(request_tx, state);
        return;
    }

    add_source_entry(state, file_index, kind);
    request_suggestions(request_tx, state);
}

fn apply_selected_suggestion_if_needed(state: &mut WizardState, kind: SourceEntryKind) -> bool {
    if !state.suggestion_explicitly_selected {
        return false;
    }
    let Some(suggestion) = state.suggestions.get(state.suggestion_index).cloned() else {
        return false;
    };
    let input = active_source_input_mut(state, kind);
    if input == &suggestion {
        return false;
    }
    *input = suggestion;
    true
}

fn add_source_entry(state: &mut WizardState, file_index: &FileIndex, kind: SourceEntryKind) {
    let value = active_source_input_mut(state, kind).trim().to_string();
    if value.is_empty() {
        state.status = match kind {
            SourceEntryKind::RtlPath => {
                "RTL path is empty. Type a path or pattern first.".to_string()
            }
            SourceEntryKind::Filelist => {
                "Filelist path is empty. Type a filelist path first.".to_string()
            }
        };
        return;
    }

    if state
        .sources
        .iter()
        .any(|entry| entry.kind == kind && entry.value == value)
    {
        state.status = format!(
            "{} '{}' is already in the source list.",
            kind.badge(),
            value
        );
        active_source_input_mut(state, kind).clear();
        return;
    }

    state.sources.push(SourceEntry {
        kind,
        value: value.clone(),
        matched_files: None,
    });
    state.source_index = state.sources.len().saturating_sub(1);
    active_source_input_mut(state, kind).clear();
    refresh_source_counts(state, file_index);
    state.status = match kind {
        SourceEntryKind::RtlPath => {
            let count = state
                .sources
                .last()
                .and_then(|entry| entry.matched_files)
                .unwrap_or(0);
            format!("Added {} '{}' ({} files).", kind.badge(), value, count)
        }
        SourceEntryKind::Filelist => format!("Added {} '{}'.", kind.badge(), value),
    };
}

fn build_selection(
    state: &mut WizardState,
    file_index: &FileIndex,
) -> Result<Option<StartupSelection>, String> {
    let output_dir = state.output_dir.trim();
    if output_dir.is_empty() {
        state.status = "Output directory is required.".to_string();
        return Ok(None);
    }
    if matches!(
        Path::new(output_dir)
            .extension()
            .and_then(|ext| ext.to_str()),
        Some("html" | "htm")
    ) {
        state.status = "Output must be a directory, not an .html file.".to_string();
        return Ok(None);
    }

    if state.sources.is_empty() {
        state.status = "Add at least one RTL path or filelist before running.".to_string();
        return Ok(None);
    }

    let rtl_paths = state
        .sources
        .iter()
        .filter(|entry| entry.kind == SourceEntryKind::RtlPath)
        .map(|entry| entry.value.clone())
        .collect::<Vec<_>>();
    let filelists = state
        .sources
        .iter()
        .filter(|entry| entry.kind == SourceEntryKind::Filelist)
        .map(|entry| entry.value.clone())
        .collect::<Vec<_>>();

    let source_args_tokens =
        match file_index.build_source_args(&rtl_paths, state.pattern_mode, &filelists) {
            Ok(tokens) => tokens,
            Err(err) => {
                state.status = err;
                return Ok(None);
            }
        };

    let extra_args_tokens = match parse_extra_args(&state.extra_args) {
        Ok(tokens) => tokens,
        Err(err) => {
            state.status = err;
            return Ok(None);
        }
    };

    Ok(Some(StartupSelection {
        output_dir: output_dir.to_string(),
        title: trim_optional(&state.title),
        source_args_tokens,
        extra_args_tokens,
        rebuild_sqlite: false,
    }))
}

fn trim_optional(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn active_text_mut(state: &mut WizardState) -> &mut String {
    match state.selected {
        Field::ExtraArgs => &mut state.extra_args,
        Field::OutputDir => &mut state.output_dir,
        Field::Title => &mut state.title,
        Field::PatternMode
        | Field::RtlPathInput
        | Field::FilelistInput
        | Field::SourceList
        | Field::Run => unreachable!("non-generic text field has no active buffer"),
    }
}

fn active_source_input_mut(state: &mut WizardState, kind: SourceEntryKind) -> &mut String {
    match kind {
        SourceEntryKind::RtlPath => &mut state.rtl_path_input,
        SourceEntryKind::Filelist => &mut state.filelist_input,
    }
}

fn stop_active_input_editing(state: &mut WizardState) -> bool {
    let was_editing = active_input_editing(state);
    state.rtl_path_editing = false;
    state.filelist_editing = false;
    state.suggestions.clear();
    state.suggestion_index = 0;
    state.suggestion_explicitly_selected = false;
    state.suggestion_target = None;
    was_editing
}

fn clear_transient_state(state: &mut WizardState) {
    state.pattern_mode_open = false;
    let _ = stop_active_input_editing(state);
}

fn active_input_editing(state: &WizardState) -> bool {
    matches!(
        active_suggestion_target(state),
        Some(SuggestionTarget::RtlPath | SuggestionTarget::Filelist)
    )
}

fn active_suggestion_target(state: &WizardState) -> Option<SuggestionTarget> {
    match state.selected {
        Field::RtlPathInput if state.rtl_path_editing => Some(SuggestionTarget::RtlPath),
        Field::FilelistInput if state.filelist_editing => Some(SuggestionTarget::Filelist),
        _ => None,
    }
}

fn remove_selected_source(state: &mut WizardState, file_index: &FileIndex) {
    if state.sources.is_empty() {
        return;
    }
    let removed = state
        .sources
        .remove(state.source_index.min(state.sources.len() - 1));
    if state.source_index >= state.sources.len() && !state.sources.is_empty() {
        state.source_index = state.sources.len() - 1;
    } else if state.sources.is_empty() {
        state.source_index = 0;
    }
    state.status = format!("Removed {} '{}'.", removed.kind.badge(), removed.value);
    refresh_source_counts(state, file_index);
}

fn render(frame: &mut ratatui::Frame<'_>, state: &WizardState) {
    let area = frame.area();
    frame.render_widget(Clear, area);
    let active_tab = WizardTab::of_field(state.selected);

    let layout = Layout::default()
        .direction(Direction::Vertical)
        .margin(1)
        .constraints([
            Constraint::Length(4),
            Constraint::Length(4),
            Constraint::Min(10),
            Constraint::Length(3),
        ])
        .split(area);

    let title = Paragraph::new(vec![
        Line::from(vec![Span::styled(
            "Hier Viewer Wizard",
            Style::default()
                .fg(Color::Yellow)
                .add_modifier(Modifier::BOLD),
        )]),
        Line::from(vec![Span::raw(
            "Start without --db. Build the RTL source list here, then run slang-hier-exporter --sqlite automatically.",
        )]),
        Line::from(vec![
            Span::styled("[Tab]", Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD)),
            Span::raw(" switch section   "),
            Span::styled("[Enter]", Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD)),
            Span::raw(" open / accept / run   "),
            Span::styled("[Esc]", Style::default().fg(Color::Red).add_modifier(Modifier::BOLD)),
            Span::raw(" leave active input"),
        ]),
    ])
    .block(
        Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(Color::DarkGray))
            .title("Startup"),
    )
    .wrap(Wrap { trim: true });
    frame.render_widget(title, layout[0]);

    render_tabs(frame, layout[1], active_tab);
    render_tab_content(frame, layout[2], state, active_tab);

    let run_style = if state.selected == Field::Run {
        Style::default()
            .fg(Color::Black)
            .bg(Color::Yellow)
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(Color::Yellow)
    };
    let run = Paragraph::new(Line::from(vec![
        Span::styled("[ Enter ]", run_style),
        Span::raw(" Run startup"),
        Span::raw("    "),
        Span::styled("[ Esc ]", Style::default().fg(Color::Red)),
        Span::raw(" Cancel / leave active input"),
        Span::raw("    "),
        Span::styled(&state.status, Style::default().fg(Color::Cyan)),
    ]))
    .block(Block::default().borders(Borders::ALL).title("Run"))
    .wrap(Wrap { trim: true });
    frame.render_widget(run, layout[3]);

    if let Some((x, y)) = cursor_position(layout[2], state, active_tab) {
        frame.set_cursor_position((x, y));
    }
}

fn render_tabs(frame: &mut ratatui::Frame<'_>, area: Rect, active_tab: WizardTab) {
    let mut spans = vec![];
    for tab in WizardTab::ALL {
        if !spans.is_empty() {
            spans.push(Span::raw("  "));
        }
        let style = if tab == active_tab {
            Style::default()
                .fg(Color::Black)
                .bg(Color::Yellow)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(Color::White).bg(Color::Rgb(60, 60, 60))
        };
        spans.push(Span::styled(
            format!(" {} {} ", tab.short_index(), tab.label()),
            style,
        ));
    }

    let paragraph = Paragraph::new(vec![
        Line::from(spans),
        Line::from(vec![Span::styled(
            active_tab.summary(),
            Style::default().fg(Color::DarkGray),
        )]),
    ])
    .block(
        Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(Color::DarkGray))
            .title("Workflow"),
    )
    .wrap(Wrap { trim: false });
    frame.render_widget(paragraph, area);
}

fn render_tab_content(
    frame: &mut ratatui::Frame<'_>,
    area: Rect,
    state: &WizardState,
    active_tab: WizardTab,
) {
    match active_tab {
        WizardTab::Input => render_input_tab(frame, area, state),
        WizardTab::Flags => render_flags_tab(frame, area, state),
        WizardTab::Output => render_output_tab(frame, area, state),
    }
}

fn render_input_tab(frame: &mut ratatui::Frame<'_>, area: Rect, state: &WizardState) {
    let layout = input_tab_layout(area, state);
    render_pattern_mode_dropdown(frame, layout.mode, state);
    render_input(
        frame,
        layout.rtl_input,
        "RTL Path",
        "type one RTL path or pattern, then press Enter to add",
        &state.rtl_path_input,
        state.selected == Field::RtlPathInput,
    );
    render_input(
        frame,
        layout.filelist_input,
        "Filelist",
        "type one filelist path, then press Enter to add",
        &state.filelist_input,
        state.selected == Field::FilelistInput,
    );
    render_source_list(frame, layout.source_list, state);
    render_help_text(
        frame,
        layout.help,
        vec![
            "Add each RTL path or pattern as its own item. No comma or semicolon separators are needed.",
            "Use the Filelist field for .f / filelist inputs. They will be passed to slang-hier-exporter with -f.",
            "Enter adds the typed path or pattern. Tab / Shift+Tab / Up / Down select a suggestion; Enter completes that selection, then Enter adds it.",
            "Focus the source list and press Delete or Backspace to remove the selected item.",
        ],
    );
    render_active_suggestion_overlay(frame, area, &layout, state);
}

fn input_tab_layout(area: Rect, state: &WizardState) -> InputTabLayout {
    let mode_height = if state.selected == Field::PatternMode && state.pattern_mode_open {
        pattern_mode_options().len() as u16 + 2
    } else {
        3
    };
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(mode_height),
            Constraint::Length(3),
            Constraint::Length(3),
            Constraint::Min(6),
            Constraint::Min(4),
        ])
        .split(area);

    InputTabLayout {
        mode: chunks[0],
        rtl_input: chunks[1],
        filelist_input: chunks[2],
        source_list: chunks[3],
        help: chunks[4],
    }
}

fn render_active_suggestion_overlay(
    frame: &mut ratatui::Frame<'_>,
    tab_area: Rect,
    layout: &InputTabLayout,
    state: &WizardState,
) {
    let (anchor, title) = match active_suggestion_target(state) {
        Some(SuggestionTarget::RtlPath) => (layout.rtl_input, "Path Suggestions"),
        Some(SuggestionTarget::Filelist) => (layout.filelist_input, "Filelist Suggestions"),
        None => return,
    };

    if state.suggestions.is_empty() {
        return;
    }

    let below_y = anchor.y.saturating_add(anchor.height);
    let remaining_height = tab_area
        .y
        .saturating_add(tab_area.height)
        .saturating_sub(below_y);
    if remaining_height < 3 {
        return;
    }

    let visible_rows = state
        .suggestions
        .len()
        .min(remaining_height.saturating_sub(2) as usize)
        .min(10);
    if visible_rows == 0 {
        return;
    }

    let dropdown_area = Rect {
        x: anchor.x,
        y: below_y,
        width: anchor.width,
        height: visible_rows as u16 + 2,
    };
    render_suggestion_dropdown(frame, dropdown_area, state, title);
}

fn render_pattern_mode_dropdown(frame: &mut ratatui::Frame<'_>, area: Rect, state: &WizardState) {
    if state.selected == Field::PatternMode && state.pattern_mode_open {
        let items = pattern_mode_options()
            .iter()
            .map(|mode| {
                let line = Line::from(vec![
                    Span::raw(format!("{}  ", mode.label())),
                    Span::styled(mode.example(), Style::default().fg(Color::DarkGray)),
                ]);
                ListItem::new(line)
            })
            .collect::<Vec<_>>();
        let mut list_state =
            ListState::default().with_selected(Some(pattern_mode_index(state.pattern_mode)));
        let list = List::new(items)
            .highlight_style(
                Style::default()
                    .fg(Color::Black)
                    .bg(Color::Yellow)
                    .add_modifier(Modifier::BOLD),
            )
            .block(
                Block::default()
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(Color::Yellow))
                    .title("RTL Match Mode"),
            );
        frame.render_widget(Clear, area);
        frame.render_stateful_widget(list, area, &mut list_state);
        return;
    }

    let hint = if state.selected == Field::PatternMode {
        "Press Enter to open dropdown"
    } else {
        state.pattern_mode.example()
    };
    let text = Line::from(vec![
        Span::styled("Mode: ", Style::default().add_modifier(Modifier::BOLD)),
        Span::raw(state.pattern_mode.label()),
        Span::raw("  "),
        Span::styled(hint, Style::default().fg(Color::DarkGray)),
    ]);
    render_paragraph(
        frame,
        area,
        "RTL Match Mode",
        vec![text],
        state.selected == Field::PatternMode,
    );
}

fn render_source_list(frame: &mut ratatui::Frame<'_>, area: Rect, state: &WizardState) {
    if state.sources.is_empty() {
        let paragraph = Paragraph::new(Line::from(Span::styled(
            "No sources added yet. Add RTL paths or filelists above.",
            Style::default().fg(Color::DarkGray),
        )))
        .block(block(
            "Source List [Del/Backspace/D/X]",
            state.selected == Field::SourceList,
        ))
        .wrap(Wrap { trim: true });
        frame.render_widget(paragraph, area);
        return;
    }

    let items = state
        .sources
        .iter()
        .map(|entry| {
            let mut spans = vec![
                Span::styled(
                    format!("[{}] ", entry.kind.badge()),
                    Style::default()
                        .fg(Color::Yellow)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::raw(entry.value.clone()),
            ];
            if let Some(count) = entry.matched_files {
                spans.push(Span::styled(
                    format!("  ({count} files)"),
                    Style::default().fg(Color::DarkGray),
                ));
            }
            ListItem::new(Line::from(spans))
        })
        .collect::<Vec<_>>();
    let mut list_state =
        ListState::default().with_selected(Some(state.source_index.min(state.sources.len() - 1)));
    let list = List::new(items)
        .highlight_style(
            Style::default()
                .fg(Color::Black)
                .bg(Color::Yellow)
                .add_modifier(Modifier::BOLD),
        )
        .block(block(
            "Source List [Del/Backspace/D/X]",
            state.selected == Field::SourceList,
        ));
    frame.render_stateful_widget(list, area, &mut list_state);
}

fn render_flags_tab(frame: &mut ratatui::Frame<'_>, area: Rect, state: &WizardState) {
    let layout = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(3), Constraint::Min(6)])
        .split(area);
    render_input(
        frame,
        layout[0],
        "Extra Args",
        "+incdir+... +define+... --top ...",
        &state.extra_args,
        state.selected == Field::ExtraArgs,
    );
    render_help_text(
        frame,
        layout[1],
        vec![
            "Pass any extra slang or project flags here.",
            "Examples: +incdir+/nfs/rtl/include ; +define+SYNTHESIS ; --top my_top",
            "These flags are appended before the source paths and filelists when slang-hier-exporter --sqlite is launched.",
        ],
    );
}

fn render_output_tab(frame: &mut ratatui::Frame<'_>, area: Rect, state: &WizardState) {
    let layout = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3),
            Constraint::Length(3),
            Constraint::Min(6),
        ])
        .split(area);
    render_input(
        frame,
        layout[0],
        "Output Dir",
        DEFAULT_OUTPUT_DIR,
        &state.output_dir,
        state.selected == Field::OutputDir,
    );
    render_input(
        frame,
        layout[1],
        "Title",
        "optional viewer title override",
        &state.title,
        state.selected == Field::Title,
    );
    render_help_text(
        frame,
        layout[2],
        vec![
            "Output must be a directory. The viewer will write index.html, viewer-meta.json, and viewer-core.bin into it.",
            "The title is optional and only changes the viewer header.",
            "Move to the Run field and press Enter when the source list is ready.",
        ],
    );
}

fn render_input(
    frame: &mut ratatui::Frame<'_>,
    area: Rect,
    title: &str,
    placeholder: &str,
    value: &str,
    selected: bool,
) {
    let style = if selected {
        Style::default().fg(Color::Yellow)
    } else {
        Style::default()
    };
    let display = if value.is_empty() {
        Line::from(Span::styled(
            placeholder,
            Style::default().fg(Color::DarkGray),
        ))
    } else {
        Line::from(Span::raw(value))
    };
    let paragraph = Paragraph::new(display)
        .style(style)
        .block(block(title, selected))
        .wrap(Wrap { trim: false });
    frame.render_widget(paragraph, area);
}

fn render_paragraph(
    frame: &mut ratatui::Frame<'_>,
    area: Rect,
    title: &str,
    lines: Vec<Line<'static>>,
    selected: bool,
) {
    let paragraph = Paragraph::new(lines)
        .block(block(title, selected))
        .wrap(Wrap { trim: true });
    frame.render_widget(paragraph, area);
}

fn render_help_text(frame: &mut ratatui::Frame<'_>, area: Rect, lines: Vec<&str>) {
    let text = lines
        .into_iter()
        .map(|line| {
            Line::from(vec![
                Span::styled("• ", Style::default().fg(Color::DarkGray)),
                Span::styled(line, Style::default().fg(Color::DarkGray)),
            ])
        })
        .collect::<Vec<_>>();
    let paragraph = Paragraph::new(text).wrap(Wrap { trim: true });
    frame.render_widget(paragraph, area);
}

fn render_suggestion_dropdown(
    frame: &mut ratatui::Frame<'_>,
    area: Rect,
    state: &WizardState,
    title: &str,
) {
    if area.height == 0 || state.suggestions.is_empty() {
        return;
    }

    let visible_items = state.suggestions.len().min(8);
    let start = if state.suggestion_index >= visible_items {
        state.suggestion_index + 1 - visible_items
    } else {
        0
    };
    let end = (start + visible_items).min(state.suggestions.len());
    let items = state.suggestions[start..end]
        .iter()
        .enumerate()
        .map(|(index, path)| {
            let absolute_index = start + index;
            let prefix = if absolute_index == state.suggestion_index {
                "› "
            } else {
                "  "
            };
            ListItem::new(Line::from(Span::raw(format!("{prefix}{path}"))))
        })
        .collect::<Vec<_>>();

    let mut list_state =
        ListState::default().with_selected(Some(state.suggestion_index.saturating_sub(start)));
    let list = List::new(items)
        .highlight_style(
            Style::default()
                .fg(Color::Black)
                .bg(Color::Yellow)
                .add_modifier(Modifier::BOLD),
        )
        .block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(Color::Yellow))
                .title(title),
        );

    frame.render_widget(Clear, area);
    frame.render_stateful_widget(list, area, &mut list_state);
}

fn block(title: &str, selected: bool) -> Block<'_> {
    let style = if selected {
        Style::default().fg(Color::Yellow)
    } else {
        Style::default()
    };
    Block::default()
        .borders(Borders::ALL)
        .border_style(style)
        .title(title)
}

fn cursor_position(
    content_area: Rect,
    state: &WizardState,
    active_tab: WizardTab,
) -> Option<(u16, u16)> {
    match active_tab {
        WizardTab::Input => {
            let layout = input_tab_layout(content_area, state);
            let (area, text, should_show) = match state.selected {
                Field::RtlPathInput => (
                    layout.rtl_input,
                    state.rtl_path_input.as_str(),
                    state.rtl_path_editing,
                ),
                Field::FilelistInput => (
                    layout.filelist_input,
                    state.filelist_input.as_str(),
                    state.filelist_editing,
                ),
                _ => return None,
            };
            if !should_show {
                return None;
            }
            let cursor_x = area.x + 1 + text.chars().count() as u16;
            let max_x = area.x + area.width.saturating_sub(2);
            Some((cursor_x.min(max_x), area.y + 1))
        }
        WizardTab::Flags => {
            if state.selected != Field::ExtraArgs {
                return None;
            }
            let layout = Layout::default()
                .direction(Direction::Vertical)
                .constraints([Constraint::Length(3), Constraint::Min(6)])
                .split(content_area);
            let area = layout[0];
            let cursor_x = area.x + 1 + state.extra_args.chars().count() as u16;
            let max_x = area.x + area.width.saturating_sub(2);
            Some((cursor_x.min(max_x), area.y + 1))
        }
        WizardTab::Output => {
            let layout = Layout::default()
                .direction(Direction::Vertical)
                .constraints([
                    Constraint::Length(3),
                    Constraint::Length(3),
                    Constraint::Min(6),
                ])
                .split(content_area);
            let (area, text) = match state.selected {
                Field::OutputDir => (layout[0], state.output_dir.as_str()),
                Field::Title => (layout[1], state.title.as_str()),
                _ => return None,
            };
            let cursor_x = area.x + 1 + text.chars().count() as u16;
            let max_x = area.x + area.width.saturating_sub(2);
            Some((cursor_x.min(max_x), area.y + 1))
        }
    }
}

fn refresh_source_counts(state: &mut WizardState, file_index: &FileIndex) {
    for entry in &mut state.sources {
        entry.matched_files = match entry.kind {
            SourceEntryKind::RtlPath => Some(
                file_index
                    .resolve_patterns(std::slice::from_ref(&entry.value), state.pattern_mode)
                    .map(|files| files.len())
                    .unwrap_or(0),
            ),
            SourceEntryKind::Filelist => None,
        };
    }
}

fn pattern_mode_options() -> [PatternMode; 3] {
    [
        PatternMode::Literal,
        PatternMode::Wildcard,
        PatternMode::Regex,
    ]
}

fn pattern_mode_index(mode: PatternMode) -> usize {
    pattern_mode_options()
        .iter()
        .position(|candidate| *candidate == mode)
        .unwrap_or(0)
}

fn spawn_suggestion_worker(
    file_index: FileIndex,
) -> (Sender<SuggestionRequest>, Receiver<SuggestionResponse>) {
    let (request_tx, request_rx) = mpsc::channel::<SuggestionRequest>();
    let (response_tx, response_rx) = mpsc::channel::<SuggestionResponse>();

    thread::spawn(move || {
        while let Ok(mut latest) = request_rx.recv() {
            while let Ok(next) = request_rx.try_recv() {
                latest = next;
            }
            let suggestions = match latest.target {
                SuggestionTarget::RtlPath => file_index.suggestions(&latest.input, latest.mode),
                SuggestionTarget::Filelist => file_index.filelist_suggestions(&latest.input),
            };
            let _ = response_tx.send(SuggestionResponse {
                seq: latest.seq,
                mode: latest.mode,
                target: latest.target,
                suggestions,
            });
        }
    });

    (request_tx, response_rx)
}

fn request_suggestions(request_tx: &Sender<SuggestionRequest>, state: &mut WizardState) {
    state.suggestion_explicitly_selected = false;
    let Some(target) = active_suggestion_target(state) else {
        state.suggestions.clear();
        state.suggestion_index = 0;
        state.suggestion_target = None;
        return;
    };
    state.latest_suggestion_seq += 1;
    state.suggestion_target = Some(target);
    let input = match target {
        SuggestionTarget::RtlPath => state.rtl_path_input.clone(),
        SuggestionTarget::Filelist => state.filelist_input.clone(),
    };
    let _ = request_tx.send(SuggestionRequest {
        seq: state.latest_suggestion_seq,
        mode: state.pattern_mode,
        target,
        input,
    });
}

fn drain_suggestion_updates(response_rx: &Receiver<SuggestionResponse>, state: &mut WizardState) {
    while let Ok(response) = response_rx.try_recv() {
        if response.mode == state.pattern_mode
            && response.seq == state.latest_suggestion_seq
            && Some(response.target) == state.suggestion_target
        {
            state.suggestions = response.suggestions;
            state.suggestion_index = 0;
            state.suggestion_explicitly_selected = false;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::fs;
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn with_workspace(test: impl FnOnce(&FileIndex)) {
        const CHILD_TEST: &str = "HIER_VIEWER_WIZARD_CHILD_TEST";
        let thread = thread::current();
        let test_name = thread.name().expect("test thread name");
        if env::var(CHILD_TEST).as_deref() == Ok(test_name) {
            test(&FileIndex::build().expect("index fixture files"));
            return;
        }

        // FileIndex::build uses cwd. Isolate it from other tests without changing process cwd.
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time before epoch")
            .as_nanos();
        let dir = env::temp_dir().join(format!(
            "hier-viewer-wizard-tests-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(dir.join("ibex/rtl")).expect("create RTL directory");
        fs::create_dir_all(dir.join("ibex/lists")).expect("create filelist directory");
        for name in ["first.sv", "second.sv", "excluded.v"] {
            fs::write(dir.join("ibex/rtl").join(name), "module top; endmodule\n")
                .expect("write RTL fixture");
        }
        for name in ["first.f", "second.f", "third.f"] {
            fs::write(dir.join("ibex/lists").join(name), "ibex/rtl/first.sv\n")
                .expect("write filelist fixture");
        }
        let output = Command::new(env::current_exe().expect("test executable"))
            .args(["--exact", test_name, "--nocapture"])
            .env(CHILD_TEST, test_name)
            .current_dir(&dir)
            .output()
            .expect("run isolated wizard test");
        fs::remove_dir_all(dir).expect("remove fixture directory");
        assert!(
            output.status.success(),
            "isolated test failed:\n{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn config() -> Config {
        Config {
            db_path: None,
            output_path: None,
            title: None,
            no_wizard: false,
            rebuild_sqlite: false,
            preview: false,
            preview_host: "127.0.0.1".to_string(),
            preview_port: 8000,
            rtl_inputs: Vec::new(),
            filelists: Vec::new(),
            extra_args_tokens: Vec::new(),
            debug: false,
        }
    }

    fn press(
        code: KeyCode,
        state: &mut WizardState,
        index: &FileIndex,
        tx: &Sender<SuggestionRequest>,
    ) {
        assert!(
            handle_key(KeyEvent::new(code, KeyModifiers::NONE), state, index, tx)
                .expect("handle wizard key")
                .is_none()
        );
    }

    fn type_text(
        text: &str,
        state: &mut WizardState,
        index: &FileIndex,
        tx: &Sender<SuggestionRequest>,
    ) {
        for ch in text.chars() {
            press(KeyCode::Char(ch), state, index, tx);
        }
    }

    fn respond(request: SuggestionRequest, state: &mut WizardState, index: &FileIndex) {
        let suggestions = match request.target {
            SuggestionTarget::RtlPath => index.suggestions(&request.input, request.mode),
            SuggestionTarget::Filelist => index.filelist_suggestions(&request.input),
        };
        let (tx, rx) = mpsc::channel();
        tx.send(SuggestionResponse {
            seq: request.seq,
            mode: request.mode,
            target: request.target,
            suggestions,
        })
        .expect("send suggestions");
        drain_suggestion_updates(&rx, state);
    }

    fn respond_latest(
        rx: &Receiver<SuggestionRequest>,
        state: &mut WizardState,
        index: &FileIndex,
    ) {
        respond(
            rx.try_iter().last().expect("pending suggestion request"),
            state,
            index,
        );
    }

    #[test]
    fn enter_preserves_wildcard_and_regex_patterns_and_expands_two_files() {
        with_workspace(|index| {
            for (mode, pattern) in [
                (PatternMode::Wildcard, "ibex/rtl/*.sv"),
                (PatternMode::Regex, r"^ibex/rtl/.*\.sv$"),
            ] {
                let mut state = WizardState::new(&config(), index);
                state.pattern_mode = mode;
                let (tx, rx) = mpsc::channel();
                type_text(pattern, &mut state, index, &tx);
                respond_latest(&rx, &mut state, index);
                assert_eq!(state.suggestions.len(), 2);
                press(KeyCode::Enter, &mut state, index, &tx);
                assert_eq!(state.sources.len(), 1);
                assert_eq!(state.sources[0].value, pattern);
                assert_eq!(state.sources[0].matched_files, Some(2));
                assert!(state.rtl_path_input.is_empty());
                state.selected = Field::Run;
                let selection = handle_key(
                    KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE),
                    &mut state,
                    index,
                    &tx,
                )
                .expect("run wizard selection")
                .expect("valid startup selection");
                let cwd = env::current_dir().expect("fixture cwd");
                let expected = ["first.sv", "second.sv"].map(|name| {
                    cwd.join("ibex/rtl")
                        .join(name)
                        .to_string_lossy()
                        .replace('\\', "/")
                });
                assert_eq!(selection.source_args_tokens, expected);
            }
        });
    }

    #[test]
    fn explicit_candidate_keys_complete_rtl_and_filelists() {
        with_workspace(|index| {
            for mode in pattern_mode_options() {
                for field in [Field::RtlPathInput, Field::FilelistInput] {
                    for key in [KeyCode::Tab, KeyCode::BackTab, KeyCode::Up, KeyCode::Down] {
                        let mut state = WizardState::new(&config(), index);
                        state.pattern_mode = mode;
                        state.selected = field;
                        state.filelist_editing = field == Field::FilelistInput;
                        let (tx, rx) = mpsc::channel();
                        let input = if field == Field::FilelistInput {
                            "ibex/lists/"
                        } else {
                            "ibex/rtl/"
                        };
                        type_text(input, &mut state, index, &tx);
                        respond_latest(&rx, &mut state, index);
                        assert_eq!(state.suggestions.len(), 3);
                        press(key, &mut state, index, &tx);
                        let expected_index = if matches!(key, KeyCode::Tab | KeyCode::Down) {
                            1
                        } else {
                            2
                        };
                        assert_eq!(state.suggestion_index, expected_index);
                        let expected = state.suggestions[expected_index].clone();
                        press(KeyCode::Enter, &mut state, index, &tx);
                        assert!(state.sources.is_empty());
                        let kind = if field == Field::FilelistInput {
                            SourceEntryKind::Filelist
                        } else {
                            SourceEntryKind::RtlPath
                        };
                        assert_eq!(active_source_input_mut(&mut state, kind), &expected);
                        assert!(!state.suggestion_explicitly_selected);
                        respond_latest(&rx, &mut state, index);
                        press(KeyCode::Enter, &mut state, index, &tx);
                        assert_eq!(state.sources.len(), 1);
                        assert_eq!(state.sources[0].kind, kind);
                        assert_eq!(state.sources[0].value, expected);
                    }
                }
            }
        });
    }

    #[test]
    fn editing_responses_and_cleanup_reset_explicit_candidate_selection() {
        with_workspace(|index| {
            for key in [
                KeyCode::Char('*'),
                KeyCode::Backspace,
                KeyCode::Esc,
                KeyCode::PageDown,
            ] {
                let mut state = WizardState::new(&config(), index);
                let (tx, rx) = mpsc::channel();
                type_text("ibex/rtl/", &mut state, index, &tx);
                respond_latest(&rx, &mut state, index);
                press(KeyCode::Down, &mut state, index, &tx);
                assert!(state.suggestion_explicitly_selected);
                press(key, &mut state, index, &tx);
                assert!(!state.suggestion_explicitly_selected);
                if matches!(key, KeyCode::Char(_) | KeyCode::Backspace) {
                    let input = state.rtl_path_input.clone();
                    // Enter before the edited input's response must not use the old selection.
                    press(KeyCode::Enter, &mut state, index, &tx);
                    assert_eq!(state.sources[0].value, input);
                } else {
                    assert!(state.suggestions.is_empty());
                    assert_eq!(state.suggestion_target, None);
                }
            }

            let mut state = WizardState::new(&config(), index);
            let (tx, rx) = mpsc::channel();
            type_text("ibex/rtl/", &mut state, index, &tx);
            respond_latest(&rx, &mut state, index);
            press(KeyCode::Char('*'), &mut state, index, &tx);
            let stale = rx.try_iter().last().expect("first pending request");
            type_text(".sv", &mut state, index, &tx);
            press(KeyCode::Down, &mut state, index, &tx);
            assert!(state.suggestion_explicitly_selected);
            respond(stale, &mut state, index);
            assert!(state.suggestion_explicitly_selected);
            respond_latest(&rx, &mut state, index);
            assert!(!state.suggestion_explicitly_selected);
            assert_eq!(state.suggestions.len(), 2);
            press(KeyCode::Enter, &mut state, index, &tx);
            assert_eq!(state.sources[0].value, "ibex/rtl/*.sv");
            assert_eq!(state.sources[0].matched_files, Some(2));
        });
    }

    #[test]
    fn build_selection_round_trips_special_cli_arguments() {
        with_workspace(|index| {
            let mut config = config();
            config.extra_args_tokens = [
                "+incdir+/path with spaces/include",
                "+define+MESSAGE=\"hello world\"",
                "+define+APOSTROPHE=it's",
                r"+define+PATH=C:\rtl\include",
                "",
                "line one\nline two\tend",
                "--top",
                "top module",
            ]
            .map(str::to_string)
            .to_vec();
            let mut state = WizardState::new(&config, index);
            let (tx, _rx) = mpsc::channel();
            type_text("ibex/rtl/*.sv", &mut state, index, &tx);
            press(KeyCode::Enter, &mut state, index, &tx);
            let selection = build_selection(&mut state, index)
                .expect("build selection")
                .expect("valid selection");
            assert_eq!(selection.extra_args_tokens, config.extra_args_tokens);
            assert_eq!(selection.source_args_tokens.len(), 2);
        });
    }
}
