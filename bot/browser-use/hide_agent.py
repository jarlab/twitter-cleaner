"""The fenced hide agent: one browser-use Agent run to operate ONE post's menu.

The agent never gets browser-use's own actions (navigate, click-by-index, type, scroll, evaluate, ...). It gets
three tools that can only touch the post we stamped by id, plus `done`:
  click_post_button(n)     click one of that post's guarded buttons (postButtons numbers them); lists the menu
  choose_menu_item(label)  click a label from the menu that is actually open; only "not interested" wordings
                           (guard.allowMenu) pass, and never one with an "@" or matching guard.denyMenu;
                           at most one committed click per run (commit=false: find it, press Escape, click nothing)
  no_matching_item()       close the menu and stop
Afterwards our code, not the agent, decides what happened (hideState, other posts vanished?, still on the feed?).
The LLM gets the post id, its button labels and the menu labels only, never post text: max_clickable_elements_length=0
turns browser-use's page snapshot into "empty page", and use_vision=False keeps screenshots out of its messages.
(browser-use still saves a screenshot per step under its agent directory in $TMPDIR; we delete that after each run.)
"""

import asyncio
import json
import re
import shutil
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from browser_use import ActionResult, Agent, Tools

from llm import LOCAL_PROVIDERS, MENU_OPENED, REFUSED, make_llm
from protocol import BrowserUseConfig, HideResult, LlmConfig

if TYPE_CHECKING:
	from server import XPage

ALLOWED = {'done', 'click_post_button', 'choose_menu_item', 'no_matching_item'}


@dataclass
class RunState:
	menu: list[str] | None = None  # labels of the menu our tool opened
	clicked: str | None = None  # label actually clicked (commit)
	rehearsed: str | None = None  # label found but not clicked (commit=false)
	hide_state: str | None = None  # hideState right after the click
	no_item: bool = False
	refused: list[str] = field(default_factory=list)


def _norm(s: str) -> str:
	return ' '.join(str(s).split())


def fenced_tools(x: 'XPage', state: RunState, post_id: str, commit: bool) -> Tools:
	tools = Tools()
	# Allowlist: drop every built-in action except `done`. exclude_action also blocks later re-registration.
	for name in list(tools.registry.registry.actions):
		if name != 'done':
			tools.exclude_action(name)
	allow = re.compile(x.site['guard']['allowMenu'], re.I)
	deny = re.compile(x.site['guard']['denyMenu'], re.I)
	finished = 'You already chose an item. Call done.'

	@tools.action("Click one of the selected post's buttons, by its number from the task; lists the menu it opens")
	async def click_post_button(n: int) -> ActionResult:
		if state.clicked or state.rehearsed:
			return ActionResult(error=finished)
		await x.call('scan', target=post_id)  # re-stamp by id, in case X re-rendered the post
		buttons = await x.call('postButtons')
		if not any(b['n'] == n for b in buttons):
			return ActionResult(error=f'There is no button {n}. Buttons: {json.dumps(buttons)}')
		await x.close_menu()
		opened = await x.open_post_menu(f'[data-tc-target] [data-tc-btn="{n}"]')
		if opened['rerendered']:
			return ActionResult(error='The post re-rendered while clicking. Call click_post_button again.')
		if not opened['clicked']:
			return ActionResult(error=f'Button {n} could not be clicked.')
		menu = opened['menu']
		if not menu['open']:
			return ActionResult(error=f'Button {n} did not open a menu. Try another button, or call no_matching_item.')
		state.menu = menu['labels']
		msg = f'{MENU_OPENED} {json.dumps(state.menu)}'
		return ActionResult(extracted_content=msg, long_term_memory=msg)

	@tools.action('Click the menu item with exactly this label, from the menu click_post_button opened; ends the task')
	async def choose_menu_item(label: str) -> ActionResult:
		if state.clicked or state.rehearsed:
			return ActionResult(error=finished)
		if state.menu is None:
			return ActionResult(error="Open the post's menu with click_post_button first.")
		wanted = _norm(label)
		# An allowlist: in a language our deny words don't cover, "Report" or "Mute" must still be refused.
		if '@' in wanted or deny.search(wanted) or not allow.search(wanted):
			state.refused.append(wanted)
			return ActionResult(error=f'{REFUSED} "{wanted}" is never allowed. Choose the "not interested" item, or call no_matching_item.')
		menu = await x.call('menu', label=wanted)  # stamps the item only if this exact label is in the OPEN menu
		if not menu['open']:
			state.menu = None
			return ActionResult(error='The menu is closed. Call click_post_button again.')
		if not menu['stamped']:
			state.refused.append(wanted)
			return ActionResult(error=f'{REFUSED} "{wanted}" is not in the menu. Items: {json.dumps(menu["labels"])}')
		if not commit:
			state.rehearsed = menu['choice']
			await x.close_menu()
			return ActionResult(is_done=True, success=True, extracted_content=f'Rehearsal: found "{state.rehearsed}", clicked nothing.')
		if not await x.click('[data-tc-choice]'):
			return ActionResult(error='That item could not be clicked.')
		state.clicked = menu['choice']
		state.hide_state = await x.wait_hidden(post_id)
		shown = state.hide_state == 'visible'
		return ActionResult(
			is_done=True,
			success=not shown,
			extracted_content=f'Clicked "{state.clicked}". The post is {"still shown" if shown else "gone from the feed"}.',
		)

	@tools.action('Call this if no menu item means "not interested in this post"; closes the menu and ends the task')
	async def no_matching_item() -> ActionResult:
		state.no_item = True
		await x.close_menu()
		return ActionResult(is_done=True, success=False, extracted_content='No matching item; menu closed.')

	return tools


async def _cost(agent: Agent, llm: LlmConfig) -> float:
	"""What this run spent: browser-use's own price table, or our llm.prices estimate if that is higher.

	For models on your own machine (LOCAL_PROVIDERS) only the estimate counts, so $0 unless you set llm.prices:
	browser-use would price any "publisher/model" id (LM Studio's naming) at OpenRouter's rates.
	"""
	usage = await agent.token_cost_service.get_usage_summary()  # same numbers as history.usage, also after a timeout
	estimate = 0.0
	prices = llm.get('prices')
	if prices:
		estimate = (usage.total_prompt_tokens * prices['in'] + usage.total_completion_tokens * prices['out']) / 1e6
	if llm['provider'] in LOCAL_PROVIDERS:
		return estimate
	return max(usage.total_cost or 0.0, estimate)


async def run_hide_agent(x: 'XPage', cfg: BrowserUseConfig, post_id: str, commit: bool) -> HideResult:
	scan = await x.call('scan', target=post_id)
	if not scan['stamped']:
		return {'ok': False, 'via': 'agent', 'reason': 'not_found'}
	before = [p['id'] for p in scan['posts']]
	buttons = await x.call('postButtons')
	if not buttons:
		return {'ok': False, 'via': 'agent', 'reason': 'caret_missing', 'detail': 'the post offers no usable buttons'}
	start_url = await x.url()

	state = RunState()
	task = x.site['agentTask'].replace('{id}', post_id).replace('{buttons}', json.dumps(buttons))
	agent = Agent(
		task=task,
		llm=make_llm(cfg['llm']),  # a fresh model per run: each Agent wraps the model's ainvoke for cost tracking
		browser_session=x.browser,
		tools=fenced_tools(x, state, post_id, commit),
		use_vision=False,
		flash_mode=True,
		use_judge=False,
		enable_planning=False,
		loop_detection_enabled=False,
		directly_open_url=False,
		enable_signal_handler=False,
		max_actions_per_step=1,
		max_failures=2,
		step_timeout=60,
		max_clickable_elements_length=0,  # no page text (post text is written by strangers, and stays on this machine)
		calculate_cost=cfg['llm']['provider'] not in LOCAL_PROVIDERS,  # no price-list downloads for a local model
		extend_system_message=x.site['agentRules'],
	)
	actions = set(agent.tools.registry.registry.actions)
	if actions != ALLOWED:  # fail closed if browser-use ever sneaks another action in
		raise RuntimeError(f'agent action set is {sorted(actions)}, expected {sorted(ALLOWED)}')

	said, timed_out = None, False
	try:
		history = await asyncio.wait_for(agent.run(max_steps=cfg['maxStepsPerHide']), cfg['agentTimeoutS'])
		said = history.final_result()
	except TimeoutError:
		timed_out = True
	finally:
		cost = await _cost(agent, cfg['llm'])
		shutil.rmtree(agent.agent_directory, ignore_errors=True)  # its per-step screenshots of your feed
		await x.close_menu()

	hint = {'buttons': buttons, 'menu': state.menu, 'refused': state.refused, 'agentSaid': said}
	base = {'via': 'agent', 'costUsd': cost, 'hint': hint}
	if await x.url() != start_url:
		return {**base, 'ok': False, 'reason': 'error', 'fatal': True, 'detail': f'the agent left the feed: {await x.url()}'}
	if state.clicked:
		label = state.clicked
		if state.hide_state != 'visible' or await x.wait_hidden(post_id, 1.0) != 'visible':
			return {**base, 'ok': True, 'label': label}
		gone = await x.vanished(before, post_id)
		if gone:
			return {**base, 'ok': False, 'reason': 'wrong_post', 'fatal': True, 'label': label,
					'detail': f'post still shown, but {gone} vanished'}
		return {**base, 'ok': False, 'reason': 'unverified', 'label': label}
	if state.rehearsed:
		return {**base, 'ok': True, 'rehearsed': True, 'label': state.rehearsed}
	if state.no_item:
		return {**base, 'ok': False, 'reason': 'no_menu_item', 'detail': json.dumps(state.menu)}
	return {**base, 'ok': False, 'reason': 'gave_up', 'detail': 'agent timed out' if timed_out else (said or 'no result')}
