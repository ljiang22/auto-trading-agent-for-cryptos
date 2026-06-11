import { names, uniqueNamesGenerator } from "unique-names-generator";
import type { Action, ActionExample } from "./types.ts";

/**
 * Composes a set of example conversations based on provided actions and a specified count.
 * It randomly selects examples from the provided actions and formats them with generated names.
 * @param actionsData - An array of `Action` objects from which to draw examples.
 * @param count - The number of examples to generate.
 * @returns A string containing formatted examples of conversations.
 */
export const composeActionExamples = (actionsData: Action[], count: number) => {
    const data: ActionExample[][][] = actionsData.map((action: Action) => [
        ...action.examples,
    ]);

    const actionExamples: ActionExample[][] = [];
    let length = data.length;
    for (let i = 0; i < count && length; i++) {
        const actionId = i % length;
        const examples = data[actionId];
        if (examples.length) {
            const rand = ~~(Math.random() * examples.length);
            actionExamples[i] = examples.splice(rand, 1)[0];
        } else {
            i--;
        }

        if (examples.length == 0) {
            data.splice(actionId, 1);
            length--;
        }
    }

    // Add a multi-action example if we have enough different actions
    if (actionsData.length >= 2 && actionExamples.length > 2) {
        // Create a multi-action example by combining two existing examples
        const firstActionName = actionsData[0].name.toUpperCase().replace(/\s+/g, '_');
        const secondActionName = actionsData.length > 1 ? actionsData[1].name.toUpperCase().replace(/\s+/g, '_') : actionsData[0].name.toUpperCase().replace(/\s+/g, '_');
        
        // Find an example to modify with multiple actions
        const exampleToModify = actionExamples[actionExamples.length - 1];
        if (exampleToModify && exampleToModify.length > 1) {
            // Modify the last message to use multiple actions
            const lastMessage = exampleToModify[exampleToModify.length - 1];
            if (lastMessage.content.action) {
                lastMessage.content.action = [firstActionName, secondActionName];
            }
        }
    }

    const formattedExamples = actionExamples.map((example) => {
        const exampleNames = Array.from({ length: 5 }, () =>
            uniqueNamesGenerator({ dictionaries: [names] })
        );

        return `\n${example
            .map((message) => {
                let actionText = "";
                if (message.content.action) {
                    // Format the action properly whether it's a string or array
                    if (Array.isArray(message.content.action)) {
                        const formattedActions = message.content.action.map(action => 
                            typeof action === 'string' ? action.toUpperCase().replace(/\s+/g, '_') : action
                        );
                        actionText = ` (${formattedActions.join(", ")})`;
                    } else {
                        const formattedAction = typeof message.content.action === 'string' 
                            ? message.content.action.toUpperCase().replace(/\s+/g, '_') 
                            : message.content.action;
                        actionText = ` (${formattedAction})`;
                    }
                }
                
                let messageString = `${message.user}: ${message.content.text}${actionText}`;
                for (let i = 0; i < exampleNames.length; i++) {
                    messageString = messageString.replaceAll(
                        `{{user${i + 1}}}`,
                        exampleNames[i]
                    );
                }
                return messageString;
            })
            .join("\n")}`;
    });

    return formattedExamples.join("\n");
};

/**
 * Composes a set of example conversations by getting a specified number of examples from each action.
 * It randomly selects the specified number of examples from each action and formats them with generated names.
 * @param actionsData - An array of `Action` objects from which to draw examples.
 * @param examplesPerAction - The number of examples to get from each action (default: 2).
 * @returns A string containing formatted examples of conversations.
 */
export const composeActionExamplesPerAction = (actionsData: Action[], examplesPerAction = 2) => {
    const actionExamples: ActionExample[][] = [];

    // Get examples from each action
    for (const action of actionsData) {
        if (action.examples && action.examples.length > 0) {
            // Make a copy of examples to avoid modifying the original
            const availableExamples = [...action.examples];
            const selectedCount = Math.min(examplesPerAction, availableExamples.length);
            
            // Randomly select examples from this action
            for (let i = 0; i < selectedCount; i++) {
                if (availableExamples.length > 0) {
                    const randomIndex = Math.floor(Math.random() * availableExamples.length);
                    const selectedExample = availableExamples.splice(randomIndex, 1)[0];
                    actionExamples.push(selectedExample);
                }
            }
        }
    }

    // Shuffle the final examples to mix actions
    for (let i = actionExamples.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [actionExamples[i], actionExamples[j]] = [actionExamples[j], actionExamples[i]];
    }

    const formattedExamples = actionExamples.map((example) => {
        const exampleNames = Array.from({ length: 5 }, () =>
            uniqueNamesGenerator({ dictionaries: [names] })
        );

        return `\n${example
            .map((message) => {
                let actionText = "";
                if (message.content.action) {
                    // Format the action properly whether it's a string or array
                    if (Array.isArray(message.content.action)) {
                        const formattedActions = message.content.action.map(action => 
                            typeof action === 'string' ? action.toUpperCase().replace(/\s+/g, '_') : action
                        );
                        actionText = ` (${formattedActions.join(", ")})`;
                    } else {
                        const formattedAction = typeof message.content.action === 'string' 
                            ? message.content.action.toUpperCase().replace(/\s+/g, '_') 
                            : message.content.action;
                        actionText = ` (${formattedAction})`;
                    }
                }
                
                let messageString = `${message.user}: ${message.content.text}${actionText}`;
                for (let i = 0; i < exampleNames.length; i++) {
                    messageString = messageString.replaceAll(
                        `{{user${i + 1}}}`,
                        exampleNames[i]
                    );
                }
                return messageString;
            })
            .join("\n")}`;
    });

    return formattedExamples.join("\n");
};

/**
 * Formats the names of the provided actions into a space-separated string.
 * @param actions - An array of `Action` objects from which to extract names.
 * @returns A space-separated string of action names.
 */
export function formatActionNames(actions: Action[]) {
    return actions
        .sort(() => 0.5 - Math.random())
        .map((action: Action) => `${action.name.toUpperCase().replace(/\s+/g, '_')}`)
        .join("  ");
}

/**
 * Formats the provided actions into a detailed string listing each action's name and description, separated by commas and newlines.
 * @param actions - An array of `Action` objects to format.
 * @returns A detailed string of actions, including names and descriptions.
 */
export function formatActions(actions: Action[]) {
    return actions
        .sort(() => 0.5 - Math.random())
        .map((action: Action) => `${action.name.toUpperCase().replace(/\s+/g, '_')}: ${action.description}`)
        .join(",\n");
}
