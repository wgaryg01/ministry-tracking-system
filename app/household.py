from app.crypto import decrypt_field


def build_household_summary(identity) -> dict:
    """
    Household composition + computed totals for an Identity. Totals
    are always derived here from the actual member rows plus the
    applicant themself — never stored as separate columns, so there's
    nothing that can drift out of sync with the real data.
    """
    members = []
    adult_count = 0
    child_count = 0
    for m in identity.household_members:
        members.append({
            "id": str(m.id),
            "member_type": m.member_type,
            "name": decrypt_field(m.encrypted_name),
            "age": m.age,
            "relationship": decrypt_field(m.encrypted_relationship) if m.encrypted_relationship else None,
        })
        if m.member_type == "adult":
            adult_count += 1
        elif m.member_type == "child":
            child_count += 1

    return {
        "household_members": members,
        "total_adults": adult_count + 1,  # +1 for the applicant themself
        "total_children": child_count,
        "total_household": adult_count + 1 + child_count,
    }
