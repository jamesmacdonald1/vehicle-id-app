"""Pydantic data models and structured output schemas for the Vehicle ID app."""

from __future__ import annotations

from typing import Dict, List, Optional
from pydantic import BaseModel, Field


class SalespersonCreate(BaseModel):
    """Payload to add a new salesperson to the database."""

    name: str = Field(..., min_length=2, max_length=100, description="Full name of the salesperson.")
    branch: str = Field(default="", max_length=100, description="Dealership site or branch location.")
    email: str = Field(default="", max_length=120, description="Work email address.")


class SalespersonRecord(BaseModel):
    """Salesperson record stored in the database."""

    id: str
    name: str
    branch: str = ""
    email: str = ""
    created_at: str
    display_label: str


class GeminiVideoExtraction(BaseModel):
    """Structured output schema extracted from walkaround video + audio."""

    registration_number: str = Field(
        description="UK or regional vehicle registration plate visible in the video or spoken by the salesperson (e.g. 'AB21 XYZ'). Uppercase."
    )
    vin: str = Field(
        description="17-character Vehicle Identification Number (VIN) read from windscreen/door jamb or spoken."
    )
    make: str = Field(description="Vehicle manufacturer detected visually or aurally.")
    model: str = Field(description="Vehicle model name.")
    variant: str = Field(
        description="Trim, special edition, or badge details detected via video."
    )
    year: int = Field(description="Estimated registration/manufacture year (e.g. 2021).")
    colour: str = Field(description="Exterior paint colour detected in video.")
    condition_inside: int = Field(
        ge=1,
        le=10,
        description="Interior condition rating out of 10 (1 = severe damage, 10 = showroom pristine).",
    )
    condition_inside_issues: str = Field(
        description="Specific interior damage or wear and tear observed in video or mentioned by salesperson."
    )
    condition_outside: int = Field(
        ge=1,
        le=10,
        description="Exterior condition rating out of 10 (1 = severe body damage, 10 = showroom pristine).",
    )
    condition_outside_issues: str = Field(
        description="Specific exterior damage or wear and tear observed in video or mentioned by salesperson."
    )
    modifications: str = Field(
        description="Any non-standard aftermarket modifications observed or mentioned, or 'None (Standard)'."
    )
    mileage: int = Field(
        description="Odometer mileage in miles read from the dashboard cluster or spoken by salesperson."
    )
    comments_bullets: List[str] = Field(
        description="Clean, de-duplicated bullet points summarising ONLY useful vehicle information spoken by the salesperson. Exclude background noise, mumblings, greetings, filler words, and off-topic chatter."
    )


class ComparableVehicle(BaseModel):
    """Comparable vehicle listing returned by the Valuation Bot."""

    title: str = Field(description="Listing headline.")
    source: str = Field(description="Market listing source.")
    status: str = Field(description="Either 'For Sale' or 'Recently Sold'.")
    make: str = Field(description="Vehicle make (must match target make).")
    model: str = Field(description="Vehicle model (must match target model).")
    year: int = Field(description="Registration year (within 10% age tolerance).")
    mileage: int = Field(description="Odometer mileage in miles (within 10% of target vehicle mileage).")
    mileage_diff_pct: float = Field(description="Percentage difference in mileage vs target vehicle.")
    price_gbp: int = Field(description="Listed or sold retail price in GBP (£).")
    location: str = Field(description="UK city/region of comparable listing.")
    condition_notes: str = Field(description="Brief comparison note.")


class GeminiValuationOutput(BaseModel):
    """Structured output schema returned by the Valuation Bot."""

    suggested_trade_in_gbp: int = Field(
        description="Recommended trade-in purchase offer to the customer in GBP (£), adjusted for interior/exterior condition and modifications."
    )
    suggested_retail_gbp: int = Field(
        description="Recommended dealership forecourt retail price in GBP (£)."
    )
    condition_adjustment_gbp: int = Field(
        description="Price adjustment in GBP applied for interior/exterior condition and modifications."
    )
    confidence_score: int = Field(
        ge=1, le=100, description="Valuation confidence percentage (1-100)."
    )
    pricing_rationale: str = Field(
        description="Concise explanation of how the trade-in offer and retail price were derived from the ±10% age/mileage comparables and condition scores."
    )
    comparables: List[ComparableVehicle] = Field(
        description="3 to 4 closely matched comparable vehicles (same make & model, age & mileage within ±10%)."
    )


class VehicleRecord(BaseModel):
    """Complete trade-in vehicle record stored in the database."""

    registration_number: str
    vin: str = ""
    make: str
    model: str
    variant: str = ""
    year: int = 2021
    colour: str
    condition_inside: int = Field(default=8, ge=1, le=10)
    condition_inside_issues: str = ""
    condition_outside: int = Field(default=8, ge=1, le=10)
    condition_outside_issues: str = ""
    modifications: str = "None"
    mot_status: str = ""
    mileage: int = 0
    purchase_value: float = 0.0
    retail_value: float = 0.0
    comments: str = ""
    salesperson: str = ""
    recorded_at: Optional[str] = None
    video_gcs_uri: str = ""
    video_url: str = ""
    sold: bool = False
    field_sources: Dict[str, str] = Field(default_factory=dict)
    inspector_skills_used: List[str] = Field(default_factory=list)
    valuation_report: Optional[Dict] = None


class SearchVehiclesRequest(BaseModel):
    """Dynamic search and filter parameters for vehicle lookup."""

    query_text: str = ""
    search_fields: List[str] = Field(
        default_factory=lambda: [
            "registration_number",
            "make",
            "model",
            "colour",
            "salesperson",
            "comments",
            "mot_status",
        ]
    )
    make_filter: str = ""
    colour_filter: str = ""
    date_from: str = ""
    date_to: str = ""
    min_price: Optional[float] = None
    max_price: Optional[float] = None
    min_mileage: Optional[int] = None
    max_mileage: Optional[int] = None
    sold_filter: str = "all"  # "all", "available", "sold"
    sort_by: str = "recorded_at_desc"
    limit: int = 50


class MarkSoldRequest(BaseModel):
    """Payload to update a vehicle's sold status."""

    sold: bool = True
    salesperson: str = ""
