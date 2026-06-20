import json
import threading

import boto3

import config

_cloudwatch = None
_lock = threading.Lock()


def _get_cw():
    global _cloudwatch
    if _cloudwatch is None:
        with _lock:
            if _cloudwatch is None:
                _cloudwatch = boto3.client("cloudwatch", region_name=config.AWS_REGION)
    return _cloudwatch


def _emit_sync(provider_name: str, *, success: bool, failover: bool, latency_ms: int) -> None:
    dims = [
        {"Name": "Service", "Value": "ai-service"},
        {"Name": "Provider", "Value": provider_name},
        {"Name": "Environment", "Value": config.ENVIRONMENT},
    ]
    metric_data = [
        {"MetricName": "RequestCount", "Value": 1.0, "Unit": "Count", "Dimensions": dims},
        {"MetricName": "Latency", "Value": float(latency_ms), "Unit": "Milliseconds", "Dimensions": dims},
    ]
    if success:
        metric_data.append({"MetricName": "SuccessCount", "Value": 1.0, "Unit": "Count", "Dimensions": dims})
    else:
        metric_data.append({"MetricName": "FailureCount", "Value": 1.0, "Unit": "Count", "Dimensions": dims})
    if failover:
        metric_data.append({"MetricName": "FailoverCount", "Value": 1.0, "Unit": "Count", "Dimensions": dims})

    try:
        _get_cw().put_metric_data(Namespace="FanVault/AI", MetricData=metric_data)
    except Exception as exc:
        print(f"[ai-metrics] CloudWatch emit failed (non-fatal): {exc}")


def emit_metrics(provider_name: str, *, success: bool, failover: bool, latency_ms: int) -> None:
    print(
        json.dumps({
            "type": "ai_metric",
            "provider": provider_name,
            "success": success,
            "failover": failover,
            "latency_ms": latency_ms,
            "environment": config.ENVIRONMENT,
        })
    )
    t = threading.Thread(
        target=_emit_sync,
        args=(provider_name,),
        kwargs={"success": success, "failover": failover, "latency_ms": latency_ms},
        daemon=True,
    )
    t.start()
