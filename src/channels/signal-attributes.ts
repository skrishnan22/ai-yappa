// Signal attributes are string→string. userId is the author of *this* message,
// which may differ from the thread starter in initialData.startedBy.
export type SignalAttributes = { eventId: string; userId?: string; threadContext?: string };

export function buildSignalAttributes(
	eventId: string,
	userId: string | undefined,
	threadContext: string | undefined,
): SignalAttributes {
	const attributes: SignalAttributes = { eventId };

	if (userId !== undefined) attributes.userId = userId;

	if (threadContext !== undefined) attributes.threadContext = threadContext;

	return attributes;
}
