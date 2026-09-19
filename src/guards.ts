/** Shared by the loop and the browser layer, so neither has to import the other for a constant. */

export const SALESFORCE_HOSTS = ['.salesforce.com', '.force.com', '.salesforce-setup.com', '.visualforce.com'];

/** Conservative on purpose: a false positive only hands the step to a human. */
export const DESTRUCTIVE = /permanently delet|cannot be undone|can't be undone|irreversibl|will be (deleted|erased|lost)/i;
