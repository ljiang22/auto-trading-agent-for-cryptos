import type React from 'react';
import { useState, useMemo } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { CheckCircle, XCircle, Loader2, Circle, List, Zap, BarChart3, Database, TrendingUp } from "lucide-react";
import { useTranslation } from 'react-i18next';

interface ActionResult {
    action: string;
    phase: string;
    status: 'success' | 'failed' | 'pending';
    content: string;
    summary?: string;
}

interface ActionTabProps {
    actionResults: ActionResult[];
    title?: string;
}

type FormattedAction = ActionResult & {
    id: string;
    label: string;
    phaseLabel: string;
};

const getPhaseIcon = (phase: string) => {
    switch (phase) {
        case 'data_gathering':
            return <Database className="size-4 text-blue-500" />;
        case 'analysis':
            return <BarChart3 className="size-4 text-purple-500" />;
        case 'prediction':
            return <TrendingUp className="size-4 text-green-500" />;
        default:
            return <Zap className="size-4 text-amber-500" />;
    }
};

const getStatusIcon = (status: string) => {
    switch (status) {
        case 'success':
            return <CheckCircle className="size-4 text-green-500" />;
        case 'failed':
            return <XCircle className="size-4 text-red-500" />;
        case 'pending':
            return <Loader2 className="size-4 text-blue-500 animate-spin" />;
        default:
            return <Circle className="size-4 text-gray-400" />;
    }
};

const getPhaseLabel = (phase: string, t: (key: string) => unknown): string => {
    switch (phase) {
        case 'data_gathering':
            return String(t('progress.phase.dataCollection'));
        case 'analysis':
            return String(t('progress.phase.analysis'));
        case 'prediction':
            return String(t('progress.phase.prediction'));
        default:
            return String(t('progress.phase.processing'));
    }
};

export const ActionTab: React.FC<ActionTabProps> = ({
    actionResults,
    title
}) => {
    const { t } = useTranslation();
    const [activeTab, setActiveTab] = useState<string>("all");
    const resolvedTitle = title ?? t('progress.actionResults');

    const formattedActions = useMemo<FormattedAction[]>(() => {
        return actionResults.map((action, index) => ({
            ...action,
            id: `action-${index}`,
            label: t('progress.resultLabel', { index: index + 1 }),
            phaseLabel: getPhaseLabel(action.phase, t)
        }));
    }, [actionResults, t]);

    // Group actions by phase for better organization
    const actionsByPhase = useMemo(() => {
        const phases = new Map<string, FormattedAction[]>();

        formattedActions.forEach(action => {
            const phase = action.phase || 'other';
            if (!phases.has(phase)) {
                phases.set(phase, []);
            }
            phases.get(phase)!.push(action);
        });

        return phases;
    }, [formattedActions]);

    if (actionResults.length === 0) {
        return null;
    }

    return (
        <div className="w-full">
            <div className="mb-4">
                <h3 className="text-lg font-semibold text-foreground">{resolvedTitle}</h3>
                <p className="text-sm text-muted-foreground">
                    {t('progress.actionsExecutedSummary', {
                        actionCount: actionResults.length,
                        phaseCount: actionsByPhase.size,
                    })}
                </p>
            </div>

            <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
                <TabsList className="flex flex-wrap gap-1 h-auto p-1 bg-muted/50">
                    {/* All Actions Tab */}
                    <TabsTrigger 
                        value="all" 
                        className="flex items-center gap-2 px-3 py-2 text-xs"
                    >
                        <List className="size-3" />
                        <span>{t('progress.allActions')}</span>
                        <Badge variant="secondary" className="text-xs px-1.5 py-0">
                            {actionResults.length}
                        </Badge>
                    </TabsTrigger>

                    {/* Individual Action Tabs */}
                    {formattedActions.map((action) => (
                        <TabsTrigger 
                            key={action.id}
                            value={action.id}
                            className="flex items-center gap-2 px-3 py-2 text-xs max-w-[180px] min-w-[120px]"
                        >
                            <span className="truncate" title={action.label}>
                                {action.label}
                            </span>
                            <Badge 
                                variant={action.status === 'success' ? 'default' : 'secondary'} 
                                className="text-xs px-1.5 py-0"
                            >
                                {action.phaseLabel}
                            </Badge>
                        </TabsTrigger>
                    ))}
                </TabsList>

                {/* All Actions Tab Content */}
                <TabsContent value="all" className="mt-4 space-y-4">
                    <div className="text-sm text-muted-foreground mb-3">
                        <span className="font-medium">{t('progress.actionOverview')}</span> - {t('progress.actionOverviewDescription')}
                    </div>
                    
                    {/* Group by phase */}
                    {Array.from(actionsByPhase.entries()).map(([phase, actions]) => (
                        <div key={phase} className="space-y-3">
                            <div className="flex items-center gap-2 py-2 border-b">
                                {getPhaseIcon(phase)}
                                <h4 className="font-medium text-foreground">
                                    {getPhaseLabel(phase, t)} ({t('progress.actionsCount', { count: actions.length })})
                                </h4>
                            </div>
                            
                            <div className="grid gap-3 ml-6">
                                {actions.map((action) => (
                                    <div key={action.id} className="flex items-center gap-3 p-3 bg-muted/20 rounded-lg border">
                                        <div className="flex items-center gap-2">
                                            {getStatusIcon(action.status)}
                                        </div>
                                        <div className="flex-1">
                                            <div className="text-sm font-medium text-foreground">
                                                {action.label}
                                            </div>
                                            <div className="text-xs text-muted-foreground line-clamp-2">
                                                {action.summary || `${action.content.substring(0, 100)}...`}
                                            </div>
                                        </div>
                                        <Badge variant={action.status === 'success' ? 'default' : 'secondary'}>
                                            {t(`progress.status.${action.status}`)}
                                        </Badge>
                                    </div>
                                ))}
                            </div>
                        </div>
                    ))}
                </TabsContent>

                {/* Individual Action Tab Contents */}
                {formattedActions.map((action) => (
                    <TabsContent key={action.id} value={action.id} className="mt-4 space-y-4">
                        <div className="flex items-center gap-3 mb-4 p-3 bg-muted/20 rounded-lg border">
                            <div className="flex items-center gap-2">
                                {getPhaseIcon(action.phase)}
                                {getStatusIcon(action.status)}
                            </div>
                            <div className="flex-1">
                                <div className="text-xs text-muted-foreground">
                                    {action.phaseLabel}
                                </div>
                            </div>
                            <Badge variant={action.status === 'success' ? 'default' : 'secondary'}>
                                {t(`progress.status.${action.status}`)}
                            </Badge>
                        </div>
                    </TabsContent>
                ))}
            </Tabs>
        </div>
    );
};
