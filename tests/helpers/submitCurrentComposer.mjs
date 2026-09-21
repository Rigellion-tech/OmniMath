export async function submitCurrentComposer(page, problemText) {
  const activate = page.getByTestId("primary-composer-activate");
  if (await activate.count()) {
    await activate.click();
    await page.getByPlaceholder("Describe assumptions, boundary conditions, or what should be found…").fill(problemText);
    await page.getByTestId("primary-composer-solve").click();
    return;
  }

  const editSubmitted = page.getByRole("button", { name: "Edit submitted problem" });
  if (await editSubmitted.count()) {
    await editSubmitted.click();
    await page.getByPlaceholder("Describe assumptions, boundary conditions, or what should be found…").fill(problemText);
    await page.getByTestId("primary-composer-solve").click();
    return;
  }

  await page.getByPlaceholder(/Type a calculus problem/i).fill(problemText);
  await page.getByRole("button", { name: /Explain|Send/i }).click();
}
