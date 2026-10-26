{{- define "urmiai.resources" -}}
requests:
  cpu: {{ .Values.resources.requests.cpu | default "50m" }}
  memory: {{ .Values.resources.requests.memory | default "128Mi" }}
limits:
  cpu: {{ .Values.resources.limits.cpu | default "500m" }}
  memory: {{ .Values.resources.limits.memory | default "512Mi" }}
{{- end -}}
